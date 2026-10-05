"""
Агентная логика.

Здесь описано то, ЧТО делает агент, без упоминания NATS, конвертов и
стриминг-транспорта. Точка входа — run_agent(), диспетчер режимов:

  • llm          — обычный стриминг-чат, один вызов модели;
  • react        — цикл «модель решает → инструмент выполняется → наблюдение»;
  • plan_execute — модель один раз строит план, рантайм детерминированно его
                   выполняет, затем модель формирует финальный ответ.

Инструменты read-only и живут в tools/. Модель не вызывает их напрямую: на
служебных шагах она возвращает JSON-решение, а рантайм валидирует и выполняет.

Контракт наружу: на вход AgentRequest, на выход — асинхронный поток событий.
Событие — это либо str (кусок текста ответа), либо Status (служебная строка
статуса для UI). Транспорт (main.py) сам раскладывает их по token()/status().

Бюджет токенов (soft stop): после фактического usage от OpenRouter копим расход
за ход. Когда остаётся только reserve — не стартуем новые decision-шаги, а один
раз финализируем ответ по уже собранным observations. Если лимит уже пробит —
финальный LLM-вызов пропускаем и отдаём короткое сообщение.
"""

import json
import os
from dataclasses import dataclass, field
from typing import AsyncIterator

from openrouter import stream_chat
from system_prompt import load_prompt
from tools import registry

# Жёсткие лимиты шагов — чтобы цикл не разрастался и демо оставалось предсказуемым.
MAX_REACT_STEPS = 3
MAX_PLAN_STEPS = 3
# Сколько раз подряд можно просить модель переформулировать (сырой JSON / unknown type),
# прежде чем soft-stop по зацикливанию.
MAX_REPHRASE_RETRIES = 2

# 0 = лимит выключен. Перекрывается AgentRequest.max_tokens / запросом с фронта.
DEFAULT_MAX_TOKENS = int(os.environ.get("MAX_TOKENS_PER_TURN", "0"))
DEFAULT_TOKEN_RESERVE = int(os.environ.get("TOKEN_BUDGET_RESERVE", "500"))


@dataclass
class AgentRequest:
    # Вся история диалога: [{"role": "user"|"assistant", "content": "..."}].
    messages: list[dict] = field(default_factory=list)
    model: str = ""
    mode: str = "llm"  # "llm" | "react" | "plan_execute"
    temperature: float | None = None
    top_p: float | None = None
    # Бюджет токенов на ход (prompt+completion). None → DEFAULT_MAX_TOKENS из env;
    # 0 / отрицательное → без лимита.
    max_tokens: int | None = None
    # Резерв под финальный ответ при soft stop. None → DEFAULT_TOKEN_RESERVE.
    token_reserve: int | None = None


@dataclass
class Status:
    """Заголовок фазы для трейса (например, «ReAct · шаг 2/3»)."""

    text: str


@dataclass
class Trace:
    """Строка/блок трейса: вызов инструмента, его результат, план и т.п."""

    text: str


@dataclass
class Thinking:
    """Фрагмент рассуждений модели — стримится по токенам на шагах решения."""

    text: str


@dataclass
class ToolCall:
    """Вызов инструмента и его результат — отдельным заметным блоком в UI."""

    name: str
    arguments: dict
    result: dict


@dataclass
class Usage:
    """Накопительный расход токенов за ход: вход (промпт) и выход (ответ).

    Во время стрима это живая оценка по длине текста, в конце каждого вызова
    модели — уточняется по точному usage от OpenRouter."""

    tin: int
    tout: int


@dataclass
class Snapshot:
    """Полный снимок одного вызова модели: что ушло (вход) и что пришло (выход).

    Делается ПОСЛЕ каждого вызова модели. messages — целиком контекст, который
    отправлен в модель (системный промпт + вся история + наблюдения инструментов);
    output — целиком ответ модели на этот вызов (даже если в UI попал короткий
    кусок). tin/tout — точные токены именно этого вызова. На фронте собираются
    в список «контекст по шагам», который можно просматривать по одному снимку."""

    label: str
    messages: list[dict]
    output: str
    tin: int
    tout: int


@dataclass
class TokenBudget:
    """Счётчик фактических токенов за ход + soft-stop пороги.

    Считаем только usage от провайдера (не эвристику). Soft stop: при
    spent >= max_total - reserve прекращаем decision/tool-циклы и оставляем
    один финальный вызов; при spent >= max_total финальный LLM тоже пропускаем.
    """

    max_total: int
    reserve: int = 500
    spent_in: int = 0
    spent_out: int = 0
    _notified_reserve: bool = False
    _notified_exceeded: bool = False

    @property
    def spent(self) -> int:
        return self.spent_in + self.spent_out

    @property
    def exceeded(self) -> bool:
        return self.spent >= self.max_total

    @property
    def should_finalize(self) -> bool:
        """Пора выходить из цикла и тратить резерв на финальный ответ."""
        return self.spent >= max(0, self.max_total - self.reserve)

    def can_continue_loop(self) -> bool:
        """Можно ли стартовать очередной decision-шаг ReAct / planner."""
        return not self.should_finalize

    def can_finalize(self) -> bool:
        """Можно ли сделать финальный LLM-вызов (ещё не пробили жёсткий потолок)."""
        return not self.exceeded

    def add_usage(self, prompt_tokens: int, completion_tokens: int) -> list[str]:
        """Учитывает дельту одного вызова. Возвращает одноразовые уведомления для UI."""
        self.spent_in += max(0, int(prompt_tokens))
        self.spent_out += max(0, int(completion_tokens))
        notes: list[str] = []
        if self.exceeded and not self._notified_exceeded:
            self._notified_exceeded = True
            notes.append(
                f"⏹ бюджет токенов исчерпан: {self.spent}/{self.max_total}"
            )
        elif self.should_finalize and not self._notified_reserve:
            self._notified_reserve = True
            notes.append(
                f"⚠ резерв бюджета: {self.spent}/{self.max_total} "
                f"(reserve={self.reserve}) — soft stop"
            )
        return notes


# Любое событие, которое отдаёт агент наружу. str — кусок финального ответа.
Event = str | Status | Trace | Thinking | ToolCall | Usage | Snapshot


def _make_budget(req: "AgentRequest") -> TokenBudget | None:
    """Собирает бюджет хода из запроса / env. None — лимит выключен."""
    limit = DEFAULT_MAX_TOKENS if req.max_tokens is None else req.max_tokens
    if limit is None or int(limit) <= 0:
        return None
    reserve = (
        DEFAULT_TOKEN_RESERVE if req.token_reserve is None else req.token_reserve
    )
    return TokenBudget(max_total=int(limit), reserve=max(0, int(reserve)))


def _est_tokens(text: str) -> int:
    """Грубая оценка числа токенов по длине текста (~4 символа на токен)."""
    return max(1, len(text) // 4)


async def _pump(
    convo: list[dict],
    req: "AgentRequest",
    totals: dict,
    *,
    as_thinking: bool,
    label: str = "",
    budget: TokenBudget | None = None,
):
    """Стримит ответ модели, обновляя счётчики токенов и отдавая Usage-события.

    Контент отдаётся как Thinking (служебные шаги) или как str-кусок финального
    ответа. Вход оцениваем сразу по длине промпта, выход — растёт по мере стрима,
    а как только придёт точный usage — оба значения уточняются до точных.
    Бюджет (если задан) обновляется только из фактического usage.

    По завершении вызова отдаёт Snapshot: полный контекст (что ушло в модель) и
    полный ответ модели за этот вызов — для панели «контекст по шагам»."""
    in_before, out_before = totals["in"], totals["out"]
    # Сразу показываем оценку входных токенов этого вызова.
    totals["in"] = in_before + _est_tokens(" ".join(m.get("content", "") for m in convo))
    yield Usage(totals["in"], totals["out"])

    out_chars = 0
    out_parts: list[str] = []  # накапливаем полный ответ модели для снимка
    async for ev in stream_chat(convo, req.model, req.temperature, req.top_p):
        if ev["type"] == "delta":
            text = ev["text"]
            out_parts.append(text)
            yield Thinking(text) if as_thinking else text
            out_chars += len(text)
            totals["out"] = out_before + _est_tokens("x" * out_chars)
            yield Usage(totals["in"], totals["out"])
        elif ev["type"] == "usage":  # точный расход — уточняем оценки
            prompt_tokens = int(ev.get("prompt_tokens") or 0)
            completion_tokens = int(ev.get("completion_tokens") or 0)
            totals["in"] = in_before + prompt_tokens
            totals["out"] = out_before + completion_tokens
            yield Usage(totals["in"], totals["out"])
            if budget is not None:
                for note in budget.add_usage(prompt_tokens, completion_tokens):
                    yield Trace(note)

    # Снимок этого вызова: вход целиком, выход целиком, токены именно за вызов.
    yield Snapshot(
        label=label,
        messages=[dict(m) for m in convo],
        output="".join(out_parts),
        tin=totals["in"] - in_before,
        tout=totals["out"] - out_before,
    )


async def run_agent(req: AgentRequest) -> AsyncIterator[Event]:
    """Диспетчер режимов. По умолчанию — обычный llm, чтобы сохранить работу чата."""
    if req.mode == "react":
        async for ev in run_react(req):
            yield ev
    elif req.mode == "plan_execute":
        async for ev in run_plan_execute(req):
            yield ev
    else:
        async for ev in run_llm(req):
            yield ev


# --------------------------------------------------------------------------- #
# Режим llm — базовый: системный промпт + история + один вызов.
# --------------------------------------------------------------------------- #


async def run_llm(req: AgentRequest) -> AsyncIterator[Event]:
    """Прогоняет запрос через модель и отдаёт токены ответа по мере генерации."""
    messages = build_messages(req)
    totals = {"in": 0, "out": 0}
    budget = _make_budget(req)
    if budget is not None:
        yield Trace(
            f"бюджет хода: max={budget.max_total}, reserve={budget.reserve}"
        )
    async for ev in _pump(
        messages, req, totals, as_thinking=False, label="LLM-вызов", budget=budget
    ):
        yield ev


def build_messages(req: AgentRequest) -> list[dict]:
    """Собирает список сообщений для LLM: системный промпт + история диалога."""
    system = load_prompt()
    messages: list[dict] = []
    if system.strip():
        messages.append({"role": "system", "content": system})
    messages.extend(req.messages)
    return messages


# --------------------------------------------------------------------------- #
# Режим react — JSON-протокол вместо native tool calling.
# --------------------------------------------------------------------------- #

REACT_PROTOCOL = """\
Ты — агент с доступом к инструментам. У тебя есть доступ только к этим инструментам:
{tools}

На КАЖДОМ шаге верни РОВНО ОДИН JSON-объект и ничего больше — без markdown, без \
пояснений. Допустимы два варианта:

1) Вызов инструмента, если нужны данные:
{{"type": "tool_call", "tool": "имя_инструмента", "arguments": {{...}}}}

2) Финальный ответ пользователю, когда данных достаточно:
{{"type": "final", "answer": "текст ответа"}}

Результат инструмента придёт следующим сообщением в формате \
{{"ok": true|false, "data": ..., "error": ...}}. Не выдумывай данные — бери их \
только из результатов инструментов."""


def _tool_signature(tool: str, arguments: object) -> str:
    """Каноническая сигнатура tool-вызова для детекции повторов (порядок ключей не важен)."""
    args = arguments if isinstance(arguments, dict) else {}
    return json.dumps(
        {"tool": tool, "arguments": args},
        sort_keys=True,
        ensure_ascii=False,
        default=str,
    )


async def _soft_finalize_react(
    convo: list[dict],
    req: AgentRequest,
    totals: dict,
    budget: TokenBudget | None,
    *,
    reason: str,
    detail: str = "",
) -> AsyncIterator[Event]:
    """Soft stop / исчерпание шагов: один финальный ответ по уже собранным данным.

    reason: "budget" | "steps" | "loop"
    detail: уточнение для loop (повтор tool / слишком много переформулировок).
    """
    if reason == "budget" and budget is not None:
        yield Status(
            f"⏹ бюджет токенов {budget.spent}/{budget.max_total} — "
            "отвечаю по собранным данным…"
        )
        yield Trace(
            f"soft stop: token budget ({budget.spent}/{budget.max_total}, "
            f"reserve={budget.reserve})"
        )
    elif reason == "loop":
        why = detail or "зацикливание"
        yield Status(f"⏹ {why} — отвечаю по собранным данным…")
        yield Trace(f"soft stop: loop ({why})")
    else:
        yield Status("ReAct: шаги исчерпаны — формирую ответ по собранным данным…")

    if budget is not None and not budget.can_finalize():
        yield (
            f"Достигнут лимит токенов ({budget.spent}/{budget.max_total}). "
            "Финальный вызов модели пропущен — смотри результаты инструментов выше."
        )
        return

    convo.append(
        {
            "role": "user",
            "content": (
                "Шаги закончились. Дай финальный ответ пользователю обычным текстом "
                "по уже собранным данным."
            ),
        }
    )
    async for ev in _pump(
        convo,
        req,
        totals,
        as_thinking=False,
        label="ReAct: финал по собранным данным",
        budget=budget,
    ):
        yield ev


async def run_react(req: AgentRequest) -> AsyncIterator[Event]:
    """ReAct: на каждом шаге модель решает — звать инструмент или дать ответ.

    Наружу отдаём максимум информации: рассуждения модели стримим по токенам,
    каждое решение/вызов инструмента/наблюдение — отдельным блоком трейса.
    Soft stop по бюджету: после фактического usage, если остался только reserve,
    выходим из цикла и один раз финализируем ответ.
    Soft stop по зацикливанию: повторный tool+args или слишком много
    служебных переформулировок → тоже soft finalize."""
    system = _compose_system(REACT_PROTOCOL.format(tools=registry.tools_description()))
    convo: list[dict] = [{"role": "system", "content": system}, *req.messages]
    totals = {"in": 0, "out": 0}
    budget = _make_budget(req)
    seen_tool_calls: set[str] = set()
    rephrase_count = 0
    if budget is not None:
        yield Trace(
            f"бюджет хода: max={budget.max_total}, reserve={budget.reserve}"
        )

    for step in range(1, MAX_REACT_STEPS + 1):
        if budget is not None and not budget.can_continue_loop():
            async for ev in _soft_finalize_react(
                convo, req, totals, budget, reason="budget"
            ):
                yield ev
            return

        yield Status(f"ReAct · шаг {step}/{MAX_REACT_STEPS}: модель решает…")
        # Решение модели накапливаем для разбора, но не выводим целиком в UI —
        # наружу идёт только текущий счётчик токенов (Usage). Что именно сделано,
        # пользователь увидит в виде перечисления: статусы шагов + карточки инструментов.
        buf: list[str] = []
        async for ev in _pump(
            convo,
            req,
            totals,
            as_thinking=True,
            label=f"ReAct шаг {step}/{MAX_REACT_STEPS}: решение",
            budget=budget,
        ):
            if isinstance(ev, Thinking):
                buf.append(ev.text)
            else:
                yield ev
        raw = "".join(buf)
        decision = _parse_json(raw)

        # Не распознали JSON — значит это обычная проза. Её безопасно отдать как
        # финальный ответ (это не утечка сырых данных, а человеческий текст).
        if decision is None:
            yield Trace("✓ модель ответила обычным текстом — финальный ответ.")
            yield raw
            return

        if decision.get("type") == "final":
            answer = str(decision.get("answer", "")).strip()
            # Защита: слабая модель иногда помещает в answer сырой JSON (карточку
            # репозитория, результат инструмента) вместо обычного текста.
            # Такое наружу не пропускаем — просим переформулировать обычным текстом.
            if not answer or _looks_like_json(answer):
                rephrase_count += 1
                yield Trace(
                    "⚠ финальный ответ выглядит как сырой JSON — "
                    f"прошу переформулировать ({rephrase_count}/{MAX_REPHRASE_RETRIES})."
                )
                convo.append({"role": "assistant", "content": raw})
                convo.append(
                    {
                        "role": "user",
                        "content": (
                            "Не отдавай сырой JSON. Сформулируй финальный ответ "
                            "обычным человеческим текстом по-русски на основе уже "
                            "полученных результатов инструментов."
                        ),
                    }
                )
                if rephrase_count >= MAX_REPHRASE_RETRIES:
                    async for ev in _soft_finalize_react(
                        convo,
                        req,
                        totals,
                        budget,
                        reason="loop",
                        detail="зацикливание: слишком много переформулировок",
                    ):
                        yield ev
                    return
                if budget is not None and not budget.can_continue_loop():
                    async for ev in _soft_finalize_react(
                        convo, req, totals, budget, reason="budget"
                    ):
                        yield ev
                    return
                continue
            yield Trace("✓ модель решила, что данных достаточно — финальный ответ.")
            yield answer
            return

        if decision.get("type") == "tool_call":
            tool = str(decision.get("tool", ""))
            arguments = decision.get("arguments") or {}
            signature = _tool_signature(tool, arguments)
            if signature in seen_tool_calls:
                yield Trace(
                    f"⏹ зацикливание: повторный вызов {tool} с теми же аргументами"
                )
                async for ev in _soft_finalize_react(
                    convo,
                    req,
                    totals,
                    budget,
                    reason="loop",
                    detail=f"зацикливание: повторный вызов {tool}",
                ):
                    yield ev
                return
            seen_tool_calls.add(signature)
            yield Status(f"ReAct · шаг {step}/{MAX_REACT_STEPS}: выполняю {tool}…")
            result = await registry.execute(tool, arguments)
            result_dict = result.to_dict()
            yield ToolCall(name=tool, arguments=arguments, result=result_dict)
            observation = json.dumps(result_dict, ensure_ascii=False, default=str)
            # Добавляем в диалог решение модели и наблюдение — как новый ход.
            convo.append({"role": "assistant", "content": raw})
            convo.append({"role": "user", "content": f"Результат {tool}: {observation}"})
            # Tool дешёвый; soft stop сработает на следующей итерации перед decision.
            continue

        # Неизвестный тип решения — просим переформулировать через наблюдение.
        rephrase_count += 1
        yield Trace(
            "⚠ неизвестный type в решении — "
            f"прошу модель переформулировать ({rephrase_count}/{MAX_REPHRASE_RETRIES})."
        )
        convo.append({"role": "assistant", "content": raw})
        convo.append(
            {
                "role": "user",
                "content": (
                    'Неизвестный type. Верни {"type": "final", ...} '
                    'или {"type": "tool_call", ...}.'
                ),
            }
        )
        if rephrase_count >= MAX_REPHRASE_RETRIES:
            async for ev in _soft_finalize_react(
                convo,
                req,
                totals,
                budget,
                reason="loop",
                detail="зацикливание: слишком много переформулировок",
            ):
                yield ev
            return

    # Шаги кончились — просим финальный ответ по собранным наблюдениям (стримом).
    async for ev in _soft_finalize_react(
        convo, req, totals, budget, reason="steps"
    ):
        yield ev


# --------------------------------------------------------------------------- #
# Режим plan_execute — один план, детерминированное исполнение, финальный ответ.
# --------------------------------------------------------------------------- #

PLAN_PROTOCOL = """\
Ты — планировщик с доступом к инструментам. Доступны только эти инструменты:
{tools}

Составь план из не более чем {max_steps} шагов, чтобы ответить на запрос \
пользователя. Верни РОВНО ОДИН JSON-объект и ничего больше — без markdown:
{{"steps": [{{"goal": "что узнаём", "tool": "имя_инструмента", "arguments": {{...}}}}]}}

Если инструменты не нужны, верни {{"steps": []}}."""


async def run_plan_execute(req: AgentRequest) -> AsyncIterator[Event]:
    """Plan-Execute: модель строит план, рантайм выполняет его без её участия.

    Tools не тратят LLM-токены — их выполняем всегда. Soft stop влияет на
    planner/finalize: если после плана жёсткий лимит уже пробит, финальный
    LLM-вызов пропускаем."""
    planner_system = _compose_system(
        PLAN_PROTOCOL.format(
            tools=registry.tools_description(), max_steps=MAX_PLAN_STEPS
        )
    )
    totals = {"in": 0, "out": 0}
    budget = _make_budget(req)
    if budget is not None:
        yield Trace(
            f"бюджет хода: max={budget.max_total}, reserve={budget.reserve}"
        )

    yield Status("Plan-Execute: составляю план…")
    # План накапливаем для разбора, но не выводим целиком — ниже отдадим его
    # перечислением шагов (Trace «📋 план») и карточками выполненных инструментов.
    buf: list[str] = []
    async for ev in _pump(
        [{"role": "system", "content": planner_system}, *req.messages],
        req,
        totals,
        as_thinking=True,
        label="Plan: планировщик",
        budget=budget,
    ):
        if isinstance(ev, Thinking):
            buf.append(ev.text)
        else:
            yield ev
    raw = "".join(buf)
    plan = _parse_json(raw) or {}
    steps = plan.get("steps") or []
    if not isinstance(steps, list):
        steps = []
    steps = steps[:MAX_PLAN_STEPS]
    yield Trace(
        f"📋 план ({len(steps)} шаг(ов)): "
        + json.dumps(steps, ensure_ascii=False, default=str)
    )

    # Детерминированно выполняем шаги — модель тут уже ничего не выбирает.
    observations: list[dict] = []
    for i, step in enumerate(steps, start=1):
        tool = str(step.get("tool", "")) if isinstance(step, dict) else ""
        arguments = step.get("arguments") or {} if isinstance(step, dict) else {}
        yield Status(f"Plan-Execute · шаг {i}/{len(steps)}: {tool}…")
        result = await registry.execute(tool, arguments)
        result_dict = result.to_dict()
        yield ToolCall(name=tool, arguments=arguments, result=result_dict)
        observations.append(
            {"tool": tool, "arguments": arguments, "result": result_dict}
        )

    # Финальный вызов: задача + план + результаты → ответ (стримом).
    if budget is not None and not budget.can_finalize():
        yield Status(
            f"⏹ бюджет токенов {budget.spent}/{budget.max_total} — "
            "финальный вызов пропущен"
        )
        yield Trace(
            f"soft stop: token budget exceeded after plan "
            f"({budget.spent}/{budget.max_total})"
        )
        yield (
            f"Достигнут лимит токенов ({budget.spent}/{budget.max_total}). "
            "Финальный вызов модели пропущен — смотри результаты инструментов выше."
        )
        return

    if budget is not None and budget.should_finalize:
        yield Status(
            f"⚠ резерв бюджета {budget.spent}/{budget.max_total} — "
            "формирую финальный ответ…"
        )

    yield Status("Plan-Execute: формирую ответ по собранным данным…")
    summary = json.dumps(
        {"plan": steps, "observations": observations},
        ensure_ascii=False,
        default=str,
    )
    final_system = _compose_system(
        "Ответь пользователю обычным текстом, опираясь ТОЛЬКО на результаты "
        "инструментов ниже. Не выдумывай данные.\n\n" + summary
    )
    async for ev in _pump(
        [{"role": "system", "content": final_system}, *req.messages],
        req,
        totals,
        as_thinking=False,
        label="Plan: финальный ответ",
        budget=budget,
    ):
        yield ev


# --------------------------------------------------------------------------- #
# Вспомогательное.
# --------------------------------------------------------------------------- #


def _looks_like_json(text: str) -> bool:
    """True, если текст — это структурированный JSON (объект/массив), а не проза.

    Нужно, чтобы распознать случай, когда слабая модель помещает в финальный ответ
    сырой результат инструмента (карточку репозитория и т.п.) вместо обычного
    текста. Простые скаляры («12», «openclaw») остаются текстом."""
    s = text.strip()
    if s.startswith("```"):
        s = s.split("\n", 1)[-1] if "\n" in s else s
        s = s.rsplit("```", 1)[0].strip()
    if not (s.startswith("{") or s.startswith("[")):
        return False
    try:
        return isinstance(json.loads(s), (dict, list))
    except json.JSONDecodeError:
        return False


def _compose_system(protocol: str) -> str:
    """Склеивает пользовательский системный промпт с протоколом режима."""
    user_prompt = load_prompt().strip()
    return f"{user_prompt}\n\n{protocol}" if user_prompt else protocol


def _parse_json(text: str) -> dict | None:
    """Извлекает JSON-объект из ответа модели (допускает ```json-обёртки и посторонний текст).

    Возвращает None, если распарсить не удалось — вызывающий код решает, что
    делать (обычно — трактовать ответ как финальный текст)."""
    if not text:
        return None
    s = text.strip()
    # Снимаем markdown-ограждение ```json ... ```.
    if s.startswith("```"):
        s = s.split("\n", 1)[-1] if "\n" in s else s
        s = s.rsplit("```", 1)[0]
    try:
        obj = json.loads(s)
        return obj if isinstance(obj, dict) else None
    except json.JSONDecodeError:
        pass
    # Фолбэк: берём первый сбалансированный {...} в тексте.
    start = s.find("{")
    end = s.rfind("}")
    if start != -1 and end > start:
        try:
            obj = json.loads(s[start : end + 1])
            return obj if isinstance(obj, dict) else None
        except json.JSONDecodeError:
            return None
    return None
