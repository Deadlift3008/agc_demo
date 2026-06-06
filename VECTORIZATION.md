# Векторный полигон: Postgres → FRIDA → Chroma

Тренировочный стенд для закрепления темы «как структурированные данные превращаются
в векторную память агента». Две страницы:

- **`/vector`** — берем строки из Postgres, склеиваем из них текстовые документы,
  превращаем в векторы эмбеддером **FRIDA** и кладем в векторную БД **Chroma**;
- **`/memory`** — пишем текстовый запрос, он векторизуется той же FRIDA
  и Chroma возвращает ближайшие по смыслу документы (retrieve).

Это ровно тот механизм, который представляет собой долгосрочную память.

## Архитектура

```
/vector:  UI ──► backend ──► Postgres (строки по PK)
                    │
                    └──► vectorizer (FRIDA, "search_document: …") ──► Chroma (upsert)

/memory:  UI ──► backend ──► vectorizer (FRIDA, "search_query: …") ──► Chroma (query)
```

| Компонент | Где | Что делает |
|---|---|---|
| `frontend/src/VectorLab.tsx` | React | страница `/vector`: таблица → колонки → строки → кнопка |
| `frontend/src/MemoryLab.tsx` | React | страница `/memory`: строка запроса → top-k ближайших |
| `backend/src/vector.ts` | Node | выборка строк по PK, сборка документов, прокси к vectorizer |
| `vectorizer/main.py` | Python | эмбеддинги FRIDA + общение с Chroma |
| `chroma` (docker) | — | сервер векторной БД, том `chromadata` |

Backend нарочно не знает ничего про ML: он только достает данные и ходит по HTTP.
Вся векторная математика живет в Python-сервисе `vectorizer/` — по той же логике,
по которой агентный рантайм живет в `agent/`.

## Шаг 1. Из строки Postgres — текстовый документ

Вектор считается не из «строки таблицы», а из текста. Поэтому первый шаг —
решить, какие колонки несут смысл, и склеить из них документ. В демо это
`backend/src/vector.ts`:

```ts
// Текст документа: выбранные колонки в виде «колонка: значение» построчно.
export function buildDocument(row: Record<string, unknown>, columns: string[]): string {
  const lines: string[] = [];
  for (const col of columns) {
    const value = row[col];
    if (value === null || value === undefined) continue;
    const text = String(value).trim();
    if (!text) continue;
    lines.push(`${col}: ${text}`);
  }
  return lines.join("\n");
}
```

Например, строка из `commits` с колонками `message` + `author_name` превращается в:

```
message: fix: resolve memory leak in gateway reconnect loop
author_name: Jane Doe
```

Вместе с текстом документу даются:

- **id** — `таблица:первичный_ключ` (`commits:a1b2c3…`), чтобы повторная
  векторизация той же строки обновляла документ (upsert), а не плодила дубли;
- **metadata** — таблица и значения PK (Chroma разрешает только
  `str | int | float | bool`), чтобы при retrieve можно было вернуться к исходной
  строке в Postgres.

## Шаг 2. Текст → вектор (FRIDA)

[FRIDA](https://huggingface.co/ai-forever/FRIDA) (`ai-forever/FRIDA`) — русскоязычный
эмбеддер от SberDevices на базе T5-энкодера, размерность вектора **1536**.

Ключевая особенность FRIDA — **префиксы-промпты**. Модель обучена так, что текст
надо кодировать по-разному в зависимости от роли:

- документ для индексации → `search_document: <текст>`;
- поисковый запрос → `search_query: <текст>`.

Забыть префикс — самая частая ошибка, качество поиска заметно падает.

В демо это `vectorizer/main.py` (префиксы уже прописаны в конфиге модели, поэтому достаточно `prompt_name`):

```python
from sentence_transformers import SentenceTransformer

model = SentenceTransformer("ai-forever/FRIDA", device="cpu")

# документы — с префиксом search_document
doc_vecs = model.encode(documents, prompt_name="search_document", normalize_embeddings=True)

# запрос — с префиксом search_query
query_vec = model.encode([query], prompt_name="search_query", normalize_embeddings=True)[0]
```

`normalize_embeddings=True` приводит векторы к единичной длине — тогда косинусная близость считается простым скалярным произведением.

## Шаг 3. Векторы → Chroma (upsert)

Chroma хранит документы в **коллекциях**. В демо коллекция = таблица:
`pg_commits`, `pg_issues`, … Метрика задается при создании коллекции:

```python
import chromadb

client = chromadb.HttpClient(host="chroma", port=8000)

col = client.get_or_create_collection(
    "pg_commits",
    metadata={"hnsw:space": "cosine"},   # косинусная близость
)

col.upsert(
    ids=["commits:a1b2c3"],              # повторный upsert с тем же id = обновление
    embeddings=[doc_vec],                # вектор от FRIDA
    documents=["message: fix memory leak…"],  # исходный текст (вернется при поиске)
    metadatas=[{"table": "commits", "sha": "a1b2c3"}],
)
```

## Шаг 4. Retrieve: запрос → ближайшие документы

```python
res = col.query(
    query_embeddings=[query_vec],        # вектор запроса (с префиксом search_query!)
    n_results=5,
    include=["documents", "metadatas", "distances"],
)

for doc_id, doc, dist in zip(res["ids"][0], res["documents"][0], res["distances"][0]):
    similarity = 1 - dist                # space=cosine ⇒ distance = 1 − cos_sim
    print(f"{similarity:.3f}  {doc_id}  {doc[:60]}")
```

Для косинусной метрики Chroma возвращает **расстояние** `1 − cos_sim`:
- `distance ≈ 0` (similarity ≈ 1) — почти тот же смысл;
- `distance ≈ 1` — смыслы не связаны.

Важно: retrieve возвращает не «ответ», а *сырые ближайшие документы*. Что с ними делать (показать, подать в контекст LLM, отфильтровать по порогу similarity) — уже задача того, кто ищет. В агентной связке именно эти документы кладутся в контекст модели — это и есть RAG.

## Сквозной мини-пример (standalone)

Тот же процесс целиком, без демо-обвязки — можно запустить отдельным скриптом при поднятом compose (`pip install sentence-transformers chromadb-client psycopg[binary]`):

```python
import chromadb
import psycopg
from sentence_transformers import SentenceTransformer

# 1. Берем данные из Postgres
with psycopg.connect("postgresql://demo:demo@localhost:5432/demo") as conn:
    rows = conn.execute(
        "SELECT sha, message FROM commits ORDER BY committed_at DESC LIMIT 20"
    ).fetchall()

# 2. Строки → документы
ids = [f"commits:{sha}" for sha, _ in rows]
docs = [f"message: {message}" for _, message in rows]

# 3. Документы → векторы (FRIDA, префикс search_document)
model = SentenceTransformer("ai-forever/FRIDA")
doc_vecs = model.encode(docs, prompt_name="search_document", normalize_embeddings=True)

# 4. Векторы → Chroma
client = chromadb.HttpClient(host="localhost", port=8000)
col = client.get_or_create_collection("demo_commits", metadata={"hnsw:space": "cosine"})
col.upsert(ids=ids, embeddings=doc_vecs.tolist(), documents=docs)

# 5. Retrieve: запрос → вектор (префикс search_query) → ближайшие документы
q = model.encode(["что чинили в утечке памяти?"], prompt_name="search_query",
                 normalize_embeddings=True)
res = col.query(query_embeddings=q.tolist(), n_results=3,
                include=["documents", "distances"])
for doc, dist in zip(res["documents"][0], res["distances"][0]):
    print(f"{1 - dist:.3f}  {doc}")
```

## HTTP API демо

Все ходит через backend (`/api`), который проксирует в `vectorizer` (порт 9000):

| Метод | Путь | Что делает |
|---|---|---|
| GET | `/api/vector/health` | готовность FRIDA и Chroma |
| GET | `/api/vector/tables` | таблицы, их PK и колонки-кандидаты в текст |
| POST | `/api/vector/vectorize` | `{table, pks, columns}` → документы + векторы → Chroma |
| GET | `/api/memory/collections` | коллекции Chroma с количеством документов |
| POST | `/api/memory/retrieve` | `{collection, query, topK}` → ближайшие документы |
| DELETE | `/api/memory/collections/:name` | удалить коллекцию (начать полигон заново) |

Пример руками, без UI:

```bash
# векторизовать два коммита по их sha
curl -s localhost:8080/api/vector/vectorize \
  -H 'Content-Type: application/json' \
  -d '{"table":"commits","pks":[["<sha1>"],["<sha2>"]],"columns":["message"]}' | jq .

# достать из памяти
curl -s localhost:8080/api/memory/retrieve \
  -H 'Content-Type: application/json' \
  -d '{"collection":"pg_commits","query":"исправление бага","topK":3}' | jq '.hits[] | {id, similarity, document}'
```

## Эксплуатационные заметки

- **Первый запуск долгий.** FRIDA — ~3 ГБ, скачивается с Hugging Face в том `hfcache` и грузится в память несколько минут. Страницы полигона опрашивают `/api/vector/health` и сами «зеленеют», когда модель готова.
- **Память.** FP32-веса FRIDA занимают ~3 ГБ RAM — Docker-машине стоит выдать 6+ ГБ. Если железо слабое, подмени эмбеддер в `docker-compose.yml`: `EMBED_MODEL=sergeyzh/rubert-tiny-turbo` (312-мерный, в ~25 раз меньше; для моделей без встроенных промптов vectorizer сам подставит текстовые префиксы).
- **Смена модели = новая память.** Векторы разных моделей несовместимы (даже размерность другая). После смены `EMBED_MODEL` удали старые коллекции на `/memory` (или `docker compose down -v`).
- **Эмбеддинг на CPU.** 25 документов — секунды, это нормально для демо.

## Куда развивать полигон (упражнения)

1. Векторизуй коммиты `openclaw` (сначала `/db` → «Выкачать с GitHub») и найди
   на `/memory` коммиты про конкретную фичу — запросом своими словами.
2. Сравни поиск по `issues` с разными наборами колонок (`title` против
   `title + state + author_login`) — как шум в документе влияет на similarity.
3. Сделай retrieve инструментом агента: добавь в `agent/tools/` тул
   `memory_search(query)`, который ходит в `vectorizer /retrieve`, зарегистрируй
   его в `agent/tools/registry.py` — и агент в режиме ReAct получит
   семантическую память (это уже настоящий RAG).
