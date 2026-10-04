"""
Точка входа питон-рантайма агента.

Тонкая склейка: поднимает NATS-транспорт и связывает входящие запросы с агентной
логикой. Вся механика стриминга — в nats_transport.py / openrouter.py, что именно
делает агент — в agent.py, а системный промпт хранится в system_prompt.py.
"""

import asyncio
import os

from agent import (
    AgentRequest,
    Snapshot,
    Status,
    Thinking,
    ToolCall,
    Trace,
    Usage,
    run_agent,
)
from nats_transport import (
    Responder,
    connect_with_retry,
    serve_requests,
    serve_rpc,
)
from system_prompt import load_prompt, save_prompt

NATS_URL = os.environ.get("NATS_URL", "nats://nats:4222")
DEFAULT_MODEL = os.environ.get("DEFAULT_MODEL", "deepseek/deepseek-v4-flash")
REQUESTS_SUBJECT = "agent.requests"
PROMPT_GET_SUBJECT = "agent.system_prompt.get"
PROMPT_SET_SUBJECT = "agent.system_prompt.set"


def _optional_int(value: object) -> int | None:
    """None/пустая строка → None; иначе int. Нужно для max_tokens из JSON/UI."""
    if value is None or value == "":
        return None
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return None


async def on_request(req: dict, responder: Responder) -> None:
    """Мост: NATS-запрос → агент → токены обратно. Транспортных деталей тут нет."""
    agent_req = AgentRequest(
        messages=req.get("messages") or [],
        model=req.get("model") or DEFAULT_MODEL,
        mode=req.get("mode") or "llm",
        temperature=req.get("temperature"),
        top_p=req.get("top_p"),
        max_tokens=_optional_int(req.get("max_tokens")),
        token_reserve=_optional_int(req.get("token_reserve")),
    )
    async for ev in run_agent(agent_req):
        # Событие — заголовок фазы / трейс / мышление / кусок финального ответа.
        if isinstance(ev, Status):
            await responder.status(ev.text)
        elif isinstance(ev, Trace):
            await responder.trace(ev.text)
        elif isinstance(ev, Thinking):
            await responder.thinking(ev.text)
        elif isinstance(ev, ToolCall):
            await responder.tool(ev.name, ev.arguments, ev.result)
        elif isinstance(ev, Usage):
            await responder.usage(ev.tin, ev.tout)
        elif isinstance(ev, Snapshot):
            await responder.snapshot(ev.label, ev.messages, ev.output, ev.tin, ev.tout)
        else:
            await responder.token(ev)
    await responder.done()


async def on_prompt_get(_req: dict) -> dict:
    """Отдаёт текущий системный промпт фронту."""
    return {"prompt": load_prompt()}


async def on_prompt_set(req: dict) -> dict:
    """Сохраняет новый системный промпт в файл рядом с рантаймом."""
    save_prompt(req.get("prompt", ""))
    return {"ok": True}


async def main() -> None:
    nc = await connect_with_retry(NATS_URL)
    print(f"agent connected to {NATS_URL}", flush=True)

    await serve_requests(nc, REQUESTS_SUBJECT, on_request)
    await serve_rpc(nc, PROMPT_GET_SUBJECT, on_prompt_get)
    await serve_rpc(nc, PROMPT_SET_SUBJECT, on_prompt_set)
    print(f"subscribed to '{REQUESTS_SUBJECT}', waiting for requests…", flush=True)

    while True:
        await asyncio.sleep(3600)


if __name__ == "__main__":
    asyncio.run(main())
