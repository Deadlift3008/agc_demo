import Fastify from "fastify";
import { connect, StringCodec, type NatsConnection } from "nats";
import {
  ALLOWED_TABLES,
  countRows,
  fetchRows,
  isAllowed,
  listColumns,
} from "./db";
import { syncAll } from "./github";

const NATS_URL = process.env.NATS_URL ?? "nats://nats:4222";
const PORT = Number(process.env.PORT ?? 8080);
const sc = StringCodec();

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

interface ChatBody {
  messages?: ChatMessage[];
  temperature?: number;
  top_p?: number;
  model?: string;
  mode?: "llm" | "react" | "plan_execute";
}

interface PromptBody {
  prompt?: string;
}

const app = Fastify({ logger: true });

// Подключаемся к NATS один раз на старте, с ретраями (агент/натс могут стартовать чуть позже).
let nc: NatsConnection | null = null;
for (let attempt = 1; ; attempt++) {
  try {
    nc = await connect({ servers: NATS_URL });
    break;
  } catch (err) {
    app.log.warn(`NATS connect failed (attempt ${attempt}): ${String(err)}`);
    if (attempt >= 30) throw err;
    await new Promise((r) => setTimeout(r, 1000));
  }
}
app.log.info(`connected to NATS at ${NATS_URL}`);

// Системный промпт живёт в файле у питон-агента; backend лишь проксирует
// get/set туда через NATS request-reply.
const PROMPT_GET_SUBJECT = "agent.system_prompt.get";
const PROMPT_SET_SUBJECT = "agent.system_prompt.set";

app.get("/api/system-prompt", async (_req, reply) => {
  try {
    const m = await nc!.request(PROMPT_GET_SUBJECT, sc.encode("{}"), {
      timeout: 5000,
    });
    return reply.send(JSON.parse(sc.decode(m.data)));
  } catch (err) {
    return reply.code(504).send({ error: `agent unavailable: ${String(err)}` });
  }
});

app.post("/api/system-prompt", async (req, reply) => {
  const body = (req.body ?? {}) as PromptBody;
  try {
    const m = await nc!.request(
      PROMPT_SET_SUBJECT,
      sc.encode(JSON.stringify({ prompt: body.prompt ?? "" })),
      { timeout: 5000 },
    );
    return reply.send(JSON.parse(sc.decode(m.data)));
  } catch (err) {
    return reply.code(504).send({ error: `agent unavailable: ${String(err)}` });
  }
});

// --- Смотрелка БД: список таблиц и постраничное содержимое (read-only) ---

app.get("/api/db/tables", async () => {
  const tables = await Promise.all(
    Object.keys(ALLOWED_TABLES).map(async (name) => ({
      name,
      rowCount: await countRows(name),
      columns: await listColumns(name),
    })),
  );
  return { tables };
});

// Выкачать с GitHub все сущности для репозиториев, что уже есть в БД (без ключа).
app.post("/api/db/sync", async (_req, reply) => {
  try {
    const synced = await syncAll();
    return { synced };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return reply.code(502).send({ error: message });
  }
});

app.get("/api/db/tables/:name", async (req, reply) => {
  const { name } = req.params as { name: string };
  if (!isAllowed(name)) {
    return reply.code(404).send({ error: `table '${name}' is not allowed` });
  }

  const q = (req.query ?? {}) as { limit?: string; offset?: string };
  // limit зажимаем в [1, 200], offset — неотрицательный. Оба идут параметрами.
  const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);

  const [columns, rowCount, rows] = await Promise.all([
    listColumns(name),
    countRows(name),
    fetchRows(name, limit, offset),
  ]);
  return { name, columns, rowCount, limit, offset, rows };
});

app.post("/api/chat", async (req, reply) => {
  const body = (req.body ?? {}) as ChatBody;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return reply.code(400).send({ error: "messages is required" });
  }

  const reqId = crypto.randomUUID();
  const respSubject = `agent.resp.${reqId}`;

  // Забираем сырой ответ под стрим (SSE-фрейминг), Fastify дальше его не трогает.
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const sub = nc!.subscribe(respSubject);

  // Если клиент отвалился — отписываемся, чтобы цикл ниже завершился.
  res.on("close", () => sub.unsubscribe());

  // Публикуем запрос для питон-агента. reply — сабжект, куда агент шлёт токены.
  nc!.publish(
    "agent.requests",
    sc.encode(
      JSON.stringify({
        reqId,
        reply: respSubject,
        messages: body.messages,
        temperature: body.temperature,
        top_p: body.top_p,
        model: body.model,
        mode: body.mode,
      }),
    ),
  );

  try {
    for await (const m of sub) {
      const data = sc.decode(m.data);
      res.write(`data: ${data}\n\n`);
      const parsed = JSON.parse(data) as { type?: string };
      if (parsed.type === "done" || parsed.type === "error") break;
    }
  } catch (err) {
    app.log.error(err);
  } finally {
    sub.unsubscribe();
    res.end();
  }
});

await app.listen({ port: PORT, host: "0.0.0.0" });
