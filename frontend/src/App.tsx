import { useEffect, useRef, useState } from "react";

// Модели для селектора. Дефолт — deepseek-v4-flash (быстрая и дешёвая).
const MODELS = ["deepseek/deepseek-v4-flash", "openai/gpt-4o-mini"];

// Режимы выполнения. Дефолт — llm (обычный чат), чтобы ничего не сломать.
type Mode = "llm" | "react" | "plan_execute";
const MODES: { value: Mode; label: string }[] = [
  { value: "llm", label: "LLM (обычный чат)" },
  { value: "react", label: "ReAct" },
  { value: "plan_execute", label: "Plan-Execute" },
];

// Готовые системные промпты — best practices под каждый режим. Показываем их
// под полем ввода как образец; кнопка «Подставить» кладёт текст в textarea.
const LLM_PROMPT = `Ты — ассистент проекта daksha-dev/openclaw. Отвечай кратко, точно и по-русски.
Если чего-то не знаешь — честно скажи об этом и не выдумывай факты.`;

const REACT_PROMPT = `Ты — агент-аналитик репозитория daksha-dev/openclaw.

Прежде чем отвечать, реши, нужны ли данные из инструментов.
- Все факты (issues, коммиты, информация о репозитории) бери ТОЛЬКО через инструменты — ничего не придумывай.
- Делай по одному вызову за шаг и опирайся на его результат, прежде чем выбрать следующий шаг.
- Как только данных достаточно — дай краткий финальный ответ по-русски.
- Если за отведённые шаги данных не хватило — честно скажи, что удалось выяснить.`;

const PLAN_EXECUTE_PROMPT = `Ты — агент с планированием для репозитория daksha-dev/openclaw.

- Составляй минимальный план: только те шаги, без которых на вопрос не ответить.
- Каждый шаг — конкретная цель и подходящий инструмент; не дублируй вызовы.
- Не планируй шаги, данные которых не понадобятся в ответе.
- В финале отвечай кратко и по-русски строго по результатам инструментов — не выдумывай факты.`;

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface ChatBody {
  messages: Message[];
  model: string;
  mode: Mode;
  temperature?: number;
  top_p?: number;
}

interface ToolResult {
  ok: boolean;
  data: unknown;
  error: string | null;
}

interface ToolInfo {
  name: string;
  arguments: unknown;
  result: ToolResult;
}

// Одно сообщение контекста, уходящего в модель (роль + содержимое).
interface ContextMsg {
  role: string;
  content: string;
}

// Полный снимок одного вызова модели: что ушло (messages) и что пришло (output),
// плюс точные токены именно этого вызова. Копятся по шагам за текущий ход.
interface Snapshot {
  label: string;
  messages: ContextMsg[];
  output: string;
  tin: number;
  tout: number;
}

interface StreamMsg {
  type:
    | "token"
    | "status"
    | "trace"
    | "thinking"
    | "tool"
    | "usage"
    | "snapshot"
    | "done"
    | "error";
  content?: string;
  error?: string;
  // поля события tool
  name?: string;
  arguments?: unknown;
  result?: ToolResult;
  // поля события usage (накопительный расход токенов за ход) и snapshot
  // (там tin/tout — токены конкретного вызова, а не накопительные)
  tin?: number;
  tout?: number;
  // поля события snapshot
  label?: string;
  messages?: ContextMsg[];
  output?: string;
}

// Накопительный трейс выполнения: всё, что происходит внутри агента.
//  • status   — заголовок фазы («ReAct · шаг 2/3»);
//  • thinking — «мышление» модели, прилетает по токенам (склеиваем в один блок);
//  • trace    — план / служебная пометка (готовый блок);
//  • tool     — вызов инструмента и его результат (заметная карточка).
type TraceKind = "status" | "thinking" | "trace" | "tool";
interface TraceEntry {
  kind: TraceKind;
  text?: string;
  tool?: ToolInfo;
}

export default function App() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [temperature, setTemperature] = useState("");
  const [topP, setTopP] = useState("");
  const [model, setModel] = useState(MODELS[0]);
  const [mode, setMode] = useState<Mode>("llm");
  const [trace, setTrace] = useState<TraceEntry[]>([]);
  const [usage, setUsage] = useState({ tin: 0, tout: 0 });
  // Снимки контекста по шагам за текущий ход (панель справа).
  const [snapshots, setSnapshots] = useState<Snapshot[]>([]);
  const [systemPrompt, setSystemPrompt] = useState("");
  const [savedPrompt, setSavedPrompt] = useState("");
  const [promptStatus, setPromptStatus] = useState("");
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement | null>(null);

  // Подтягиваем текущий системный промпт из файла агента при загрузке.
  useEffect(() => {
    fetch("/api/system-prompt")
      .then((r) => r.json())
      .then((d) => {
        setSystemPrompt(d.prompt ?? "");
        setSavedPrompt(d.prompt ?? "");
      })
      .catch(() => {});
  }, []);

  // Автоскролл вниз по мере появления новых токенов/сообщений.
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  async function saveSystemPrompt() {
    setPromptStatus("Сохраняю…");
    try {
      const res = await fetch("/api/system-prompt", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: systemPrompt }),
      });
      if (res.ok) {
        setSavedPrompt(systemPrompt); // зафиксировали — поле больше не «грязное»
        setPromptStatus("Сохранено ✓");
      } else {
        setPromptStatus(`Ошибка ${res.status}`);
      }
    } catch (err) {
      setPromptStatus(`Ошибка: ${String(err)}`);
    }
  }

  // Подставляет готовый промпт-образец в поле. НЕ сохраняет на сервер — это
  // отдельный шаг (кнопка ниже), поэтому сразу подсказываем про сохранение.
  function applyPrompt(text: string) {
    setSystemPrompt(text);
    setPromptStatus("Нажмите «Сохранить промпт», чтобы применить.");
  }

  // Добавляет текстовую запись в трейс. Токены «мышления» склеиваем в последний
  // блок, чтобы они копились в одном месте, а не плодили сотни строк.
  function pushTrace(kind: "status" | "thinking" | "trace", text: string) {
    setTrace((prev) => {
      if (kind === "thinking") {
        const last = prev[prev.length - 1];
        if (last && last.kind === "thinking") {
          const copy = prev.slice();
          copy[copy.length - 1] = { ...last, text: (last.text ?? "") + text };
          return copy;
        }
      }
      return [...prev, { kind, text }];
    });
  }

  // Добавляет в трейс карточку вызова инструмента.
  function pushTool(tool: ToolInfo) {
    setTrace((prev) => [...prev, { kind: "tool", tool }]);
  }

  // Дописывает текст в последнее (ассистентское) сообщение.
  function appendToLast(text: string) {
    setMessages((prev) => {
      const copy = prev.slice();
      const last = copy[copy.length - 1];
      copy[copy.length - 1] = { ...last, content: last.content + text };
      return copy;
    });
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!query.trim() || loading) return;

    // История для запроса = всё, что было, + новое сообщение пользователя.
    const history: Message[] = [...messages, { role: "user", content: query }];
    // На экране сразу добавляем и реплику юзера, и пустой ответ ассистента.
    setMessages([...history, { role: "assistant", content: "" }]);
    setQuery("");
    setLoading(true);
    setTrace([]); // трейс — за текущий ход; начинаем с чистого листа
    setUsage({ tin: 0, tout: 0 }); // счётчик токенов — тоже за текущий ход
    setSnapshots([]); // снимки контекста — за текущий ход

    const controller = new AbortController();
    abortRef.current = controller;

    const body: ChatBody = { messages: history, model, mode };
    if (temperature !== "") body.temperature = Number(temperature);
    if (topP !== "") body.top_p = Number(topP);

    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!res.ok || !res.body) {
        const text = await res.text();
        appendToLast(`[ошибка ${res.status}] ${text}`);
        return;
      }

      // Читаем стрим и руками разбираем SSE-фрейминг (data: {...}\n\n).
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        const parts = buffer.split("\n\n");
        buffer = parts.pop() ?? "";
        for (const part of parts) {
          const line = part.trim();
          if (!line.startsWith("data:")) continue;
          const json = line.slice("data:".length).trim();
          let msg: StreamMsg;
          try {
            msg = JSON.parse(json) as StreamMsg;
          } catch {
            continue;
          }
          if (msg.type === "token" && msg.content) {
            appendToLast(msg.content);
          } else if (msg.type === "status") {
            pushTrace("status", msg.content ?? "");
          } else if (msg.type === "thinking") {
            pushTrace("thinking", msg.content ?? "");
          } else if (msg.type === "trace") {
            pushTrace("trace", msg.content ?? "");
          } else if (msg.type === "tool") {
            pushTool({
              name: msg.name ?? "",
              arguments: msg.arguments,
              result: msg.result ?? { ok: false, data: null, error: null },
            });
          } else if (msg.type === "usage") {
            setUsage({ tin: msg.tin ?? 0, tout: msg.tout ?? 0 });
          } else if (msg.type === "snapshot") {
            setSnapshots((prev) => [
              ...prev,
              {
                label: msg.label ?? "",
                messages: msg.messages ?? [],
                output: msg.output ?? "",
                tin: msg.tin ?? 0,
                tout: msg.tout ?? 0,
              },
            ]);
          } else if (msg.type === "error") {
            appendToLast(`\n\n[error] ${msg.error}`);
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== "AbortError") {
        appendToLast(`\n\n[client error] ${String(err)}`);
      }
    } finally {
      setLoading(false);
      abortRef.current = null;
    }
  }

  function newChat() {
    abortRef.current?.abort();
    setMessages([]);
    setQuery("");
    setTrace([]);
    setUsage({ tin: 0, tout: 0 });
    setSnapshots([]);
  }

  return (
    <div className="page">
      {/* Левая колонка (2/3): сам чат — шапка, настройки, поток, ввод. */}
      <div className="main-col">
      <header className="topbar">
        <h1 className="title">Демо курса</h1>
        <div className="topbar-actions">
          <button type="button" className="ghost" onClick={newChat}>
            ＋ Новый чат
          </button>
          <button
            type="button"
            className="ghost"
            onClick={() => setShowSettings((s) => !s)}
          >
            ⚙ Параметры
          </button>
          <a className="ghost" href="/db">
            ⛁ БД
          </a>
        </div>
      </header>

      {showSettings && (
        <div className="settings">
          <div className="settings-row">
            <label>
              Модель
              <select value={model} onChange={(e) => setModel(e.target.value)}>
                {MODELS.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Режим
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as Mode)}
              >
                {MODES.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Температура
              <input
                type="number"
                step="0.1"
                min="0"
                max="2"
                placeholder="по умолчанию"
                value={temperature}
                onChange={(e) => setTemperature(e.target.value)}
              />
            </label>
            <label>
              top-p
              <input
                type="number"
                step="0.05"
                min="0"
                max="1"
                placeholder="по умолчанию"
                value={topP}
                onChange={(e) => setTopP(e.target.value)}
              />
            </label>
          </div>

          <label className="prompt-label">
            Системный промпт
            <textarea
              className="prompt-input"
              rows={5}
              value={systemPrompt}
              onChange={(e) => {
                setSystemPrompt(e.target.value);
                setPromptStatus("");
              }}
              placeholder="Задай поведение ассистента…"
            />
          </label>
          <div className="prompt-actions">
            <button type="button" className="save" onClick={saveSystemPrompt}>
              Сохранить промпт
            </button>
            {systemPrompt !== savedPrompt && (
              <span className="prompt-dirty">● не сохранено</span>
            )}
            <span className="prompt-status">{promptStatus}</span>
          </div>

          <div className="prompt-examples">
            <div className="prompt-examples-title">
              Примеры системных промптов (best practices)
            </div>

            <div className="prompt-example">
              <div className="prompt-example-head">
                <strong>LLM — обычный чат</strong>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => applyPrompt(LLM_PROMPT)}
                >
                  Подставить
                </button>
              </div>
              <pre className="prompt-example-body">{LLM_PROMPT}</pre>
            </div>

            <div className="prompt-example">
              <div className="prompt-example-head">
                <strong>ReAct — агент с инструментами</strong>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => applyPrompt(REACT_PROMPT)}
                >
                  Подставить
                </button>
              </div>
              <pre className="prompt-example-body">{REACT_PROMPT}</pre>
              <div className="prompt-example-note">
                Формат вызова инструментов (JSON-протокол и список инструментов)
                агент добавляет сам — в промпте описывай только поведение и
                стратегию, а не формат ответа.
              </div>
            </div>

            <div className="prompt-example">
              <div className="prompt-example-head">
                <strong>Plan-Execute — план, затем исполнение</strong>
                <button
                  type="button"
                  className="ghost"
                  onClick={() => applyPrompt(PLAN_EXECUTE_PROMPT)}
                >
                  Подставить
                </button>
              </div>
              <pre className="prompt-example-body">{PLAN_EXECUTE_PROMPT}</pre>
              <div className="prompt-example-note">
                Формат плана (JSON со списком шагов) и список инструментов агент
                добавляет сам. Этот промпт влияет и на план, и на финальный ответ
                по собранным данным — описывай стратегию планирования и тон ответа.
              </div>
            </div>
          </div>
        </div>
      )}

      <div className="chat">
        {messages.map((m, i) => {
          const isLast = i === messages.length - 1;
          // Трейс выполнения показываем внутри последнего ответа ассистента —
          // над текстом ответа, чтобы был виден весь ход «как получился ответ».
          const showTrace =
            m.role === "assistant" && isLast && trace.length > 0;
          return (
            <div key={i} className={`msg msg-${m.role}`}>
              <div className="msg-role">
                {m.role === "user" ? "Вы" : "Ассистент"}
              </div>
              {showTrace && <TracePanel entries={trace} live={loading} />}
              <div className="msg-content">
                {m.content || (loading && isLast ? "…" : "")}
              </div>
            </div>
          );
        })}
        <div ref={bottomRef} />
      </div>

      <form onSubmit={onSubmit} className="composer">
        <input
          className="input"
          type="text"
          placeholder="Запрос"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          autoFocus
        />
        <button className="go" type="submit" disabled={loading}>
          {loading ? "…" : "→"}
        </button>
      </form>
      </div>

      {/* Правая колонка (1/3): токены сверху + контекст по шагам под ними. */}
      <aside className="side-col">
        <div className="token-meter">
          <div className="token-meter-title">
            Токены{loading ? " · live" : ""}
          </div>
          <div className="token-row">
            <span>↓ вход</span>
            <b>{usage.tin}</b>
          </div>
          <div className="token-row">
            <span>↑ выход</span>
            <b>{usage.tout}</b>
          </div>
          <div className="token-row token-total">
            <span>Σ всего</span>
            <b>{usage.tin + usage.tout}</b>
          </div>
        </div>

        {/* Контекст по шагам: полный снимок каждого вызова модели (вход + выход). */}
        <ContextPanel snapshots={snapshots} live={loading} />
      </aside>
    </div>
  );
}

// Панель «контекст по шагам»: справа, по одному снимку на каждый вызов модели.
// Каждый снимок раскрывается — видно ЦЕЛИКОМ что ушло в модель (системный промпт +
// история + наблюдения инструментов) и ЦЕЛИКОМ ответ модели на этот вызов, плюс
// точные токены вызова. Так видно, почему «вход N / выход M» именно такие.
function ContextPanel({
  snapshots,
  live,
}: {
  snapshots: Snapshot[];
  live: boolean;
}) {
  if (snapshots.length === 0 && !live) return null;
  return (
    <aside className="ctx-panel">
      <div className="ctx-head">
        Контекст по шагам{live ? " · идёт…" : ""}
      </div>
      {snapshots.length === 0 ? (
        <div className="ctx-empty">Снимков пока нет…</div>
      ) : (
        snapshots.map((s, i) => (
          <details key={i} className="ctx-step" open={i === snapshots.length - 1}>
            <summary className="ctx-step-head">
              <span className="ctx-step-n">#{i + 1}</span>
              <span className="ctx-step-label">{s.label || "вызов модели"}</span>
              <span className="ctx-step-tok">
                ↓{s.tin} ↑{s.tout}
              </span>
            </summary>
            <div className="ctx-block-title">Контекст (in) → модель</div>
            {s.messages.map((m, j) => (
              <div key={j} className="ctx-msg">
                <div className="ctx-msg-role">{m.role}</div>
                <pre className="ctx-msg-body">{m.content}</pre>
              </div>
            ))}
            <div className="ctx-block-title">Результат (out) ← модель</div>
            <pre className="ctx-out">{s.output || "(пусто)"}</pre>
          </details>
        ))
      )}
    </aside>
  );
}

// Панель «ход выполнения»: накопительный лог всего, что делает агент —
// заголовки фаз, стримящееся мышление модели, вызовы инструментов и их результаты.
function TracePanel({
  entries,
  live,
}: {
  entries: TraceEntry[];
  live: boolean;
}) {
  return (
    <div className="trace">
      <div className="trace-head">
        Ход выполнения{live ? " · идёт…" : ""}
      </div>
      {entries.map((e, i) => (
        <div key={i} className={`trace-item trace-${e.kind}`}>
          {e.kind === "tool" && e.tool ? (
            <div className="tool-card">
              <div className="tool-card-head">
                <span className="tool-badge">вызван тул</span>
                <code className="tool-sig">
                  {e.tool.name}({JSON.stringify(e.tool.arguments ?? {})})
                </code>
                <span
                  className={e.tool.result.ok ? "tool-ok" : "tool-err"}
                >
                  {e.tool.result.ok ? "ok" : "error"}
                </span>
              </div>
              <pre className="tool-card-body">
                {JSON.stringify(e.tool.result, null, 2)}
              </pre>
            </div>
          ) : (
            <>
              {e.kind === "thinking" && (
                <span className="trace-tag">мышление</span>
              )}
              <span className="trace-text">{e.text}</span>
            </>
          )}
        </div>
      ))}
    </div>
  );
}
