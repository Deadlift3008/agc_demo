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
import {
  MAX_PKS,
  VECTOR_TABLES,
  buildDocument,
  buildId,
  buildMetadata,
  callVectorizer,
  collectionFor,
  fetchRowsByPk,
} from "./vector";

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
  /** Бюджет токенов на ход (prompt+completion). 0 / omit — из env агента. */
  max_tokens?: number;
  /** Резерв под финальный ответ при soft stop. */
  token_reserve?: number;
}

interface PromptBody {
  prompt?: string;
}

const app = Fastify({ logger: true });

// Подключаемся к NATS один раз на старте, с повторными попытками (агент/NATS могут стартовать чуть позже).
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

// Системный промпт хранится в файле у Python-агента; backend лишь проксирует
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

// --- Просмотр БД: список таблиц и постраничное содержимое (read-only) ---

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

// Загрузить с GitHub все сущности для репозиториев, которые уже есть в БД (без ключа).
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
  // limit ограничиваем диапазоном [1, 200], offset — неотрицательный. Оба передаются параметрами.
  const limit = Math.min(Math.max(Number(q.limit) || 25, 1), 200);
  const offset = Math.max(Number(q.offset) || 0, 0);

  const [columns, rowCount, rows] = await Promise.all([
    listColumns(name),
    countRows(name),
    fetchRows(name, limit, offset),
  ]);
  return { name, columns, rowCount, limit, offset, rows };
});

// --- Векторный полигон: Postgres → FRIDA → Chroma (страницы /vector и /memory) ---

interface VectorizeBody {
  table?: string;
  pks?: unknown[][];
  columns?: string[];
}

interface RetrieveBody {
  collection?: string;
  query?: string;
  topK?: number;
}

// Готовность эмбеддера и Chroma (фронт опрашивает, пока модель грузится).
app.get("/api/vector/health", async (_req, reply) => {
  const { status, data } = await callVectorizer("/health");
  return reply.code(status).send(data);
});

// Таблицы, доступные для векторизации: первичный ключ + колонки-кандидаты в текст.
app.get("/api/vector/tables", async () => {
  const tables = await Promise.all(
    Object.entries(VECTOR_TABLES).map(async ([name, cfg]) => ({
      name,
      pk: cfg.pk,
      textColumns: cfg.textColumns,
      collection: collectionFor(name),
      rowCount: await countRows(name),
      columns: await listColumns(name),
    })),
  );
  return { tables };
});

// Главная кнопка страницы /vector: выбранные строки → документы → векторы → Chroma.
app.post("/api/vector/vectorize", async (req, reply) => {
  const body = (req.body ?? {}) as VectorizeBody;
  const table = body.table ?? "";
  const cfg = VECTOR_TABLES[table];
  if (!cfg) {
    return reply.code(404).send({ error: `table '${table}' is not allowed` });
  }
  if (!Array.isArray(body.pks) || body.pks.length === 0) {
    return reply.code(400).send({ error: "pks is required — выбери строки" });
  }
  if (body.pks.length > MAX_PKS) {
    return reply.code(400).send({ error: `не больше ${MAX_PKS} строк за раз` });
  }

  // Колонки для текста: только реально существующие в таблице (information_schema).
  const known = new Set((await listColumns(table)).map((c) => c.name));
  const columns = (body.columns ?? cfg.textColumns).filter((c) => known.has(c));
  if (columns.length === 0) {
    return reply.code(400).send({ error: "columns пуст — выбери хотя бы одну колонку" });
  }

  const rows = await fetchRowsByPk(table, cfg.pk, body.pks);
  const items: { id: string; document: string; metadata: Record<string, unknown> }[] = [];
  const skipped: string[] = []; // строки без текста — вектору не из чего получиться
  for (const row of rows) {
    const id = buildId(table, cfg.pk, row);
    const document = buildDocument(row, columns);
    if (!document) {
      skipped.push(id);
      continue;
    }
    items.push({ id, document, metadata: buildMetadata(table, cfg.pk, row) });
  }
  if (items.length === 0) {
    return reply
      .code(400)
      .send({ error: "в выбранных строках и колонках нет текста", skipped });
  }

  const collection = collectionFor(table);
  const { status, data } = await callVectorizer("/vectorize", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ collection, items }),
  });
  if (status >= 400) return reply.code(status).send(data);

  // Склеиваем ответ для UI: документ + его вектор бок о бок.
  const vectors = (data.vectors ?? []) as number[][];
  return {
    collection,
    model: data.model,
    dim: data.dim,
    count: items.length,
    skipped,
    items: items.map((it, i) => ({ ...it, vector: vectors[i] ?? [] })),
  };
});

// Страница /memory: список коллекций, поиск по смыслу, очистка.
app.get("/api/memory/collections", async (_req, reply) => {
  const { status, data } = await callVectorizer("/collections");
  return reply.code(status).send(data);
});

app.post("/api/memory/retrieve", async (req, reply) => {
  const body = (req.body ?? {}) as RetrieveBody;
  if (!body.collection || !body.query?.trim()) {
    return reply.code(400).send({ error: "collection и query обязательны" });
  }
  const { status, data } = await callVectorizer("/retrieve", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      collection: body.collection,
      query: body.query,
      top_k: body.topK ?? 5,
    }),
  });
  return reply.code(status).send(data);
});

app.delete("/api/memory/collections/:name", async (req, reply) => {
  const { name } = req.params as { name: string };
  const { status, data } = await callVectorizer(
    `/collections/${encodeURIComponent(name)}`,
    { method: "DELETE" },
  );
  return reply.code(status).send(data);
});

app.post("/api/chat", async (req, reply) => {
  const body = (req.body ?? {}) as ChatBody;
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return reply.code(400).send({ error: "messages is required" });
  }

  const reqId = crypto.randomUUID();
  const respSubject = `agent.resp.${reqId}`;

  // Берём сырой ответ для стрима (SSE-фрейминг), Fastify дальше его не обрабатывает.
  reply.hijack();
  const res = reply.raw;
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });

  const sub = nc!.subscribe(respSubject);

  // Если клиент отключился — отписываемся, чтобы цикл ниже завершился.
  res.on("close", () => sub.unsubscribe());

  // Публикуем запрос для Python-агента. reply — субъект, куда агент отправляет токены.
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
        max_tokens: body.max_tokens,
        token_reserve: body.token_reserve,
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
