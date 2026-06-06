"""
Сервис векторизации: эмбеддер FRIDA + векторная БД Chroma.

Зачем отдельный сервис: эмбеддер — тяжёлая ML-модель (PyTorch), её место в
Python-контейнере, а не в Node-бекенде. Backend остаётся тонким шлюзом: достаёт
строки из Postgres, а сюда ходит по обычному HTTP.

Два «глагола» полигона:
  POST /vectorize — текстовые документы → векторы → upsert в коллекцию Chroma.
                    FRIDA кодирует их с префиксом «search_document: …».
  POST /retrieve  — поисковая строка → вектор → ближайшие документы из Chroma.
                    Запрос кодируется с ДРУГИМ префиксом «search_query: …» —
                    это асимметричный поиск, так FRIDA обучена.

Модель грузится в фоне при старте (первый запуск скачивает ~3 ГБ с Hugging Face
в кеш-том), готовность видна в GET /health — фронт опрашивает его и не даёт
жать кнопки раньше времени.
"""

import os
import threading

from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

EMBED_MODEL = os.environ.get("EMBED_MODEL", "ai-forever/FRIDA")
# cpu | cuda | mps — на чём считать эмбеддинги (в docker-демо это CPU).
EMBED_DEVICE = os.environ.get("EMBED_DEVICE", "cpu")
CHROMA_HOST = os.environ.get("CHROMA_HOST", "chroma")
CHROMA_PORT = int(os.environ.get("CHROMA_PORT", "8000"))

# Ограничители для демо: не даём заэмбеддить полтаблицы за раз и не просим
# у Chroma тысячу соседей.
MAX_ITEMS = 50
TOP_K_MAX = 20

app = FastAPI(title="vectorizer")

# --- Модель: грузим в фоне, статус отдаём в /health -------------------------

_model = None
_model_error: str | None = None
_model_loading = True
# encode() гоняет PyTorch — сериализуем вызовы, чтобы не драться за CPU.
_encode_lock = threading.Lock()


def _load_model() -> None:
    global _model, _model_error, _model_loading
    try:
        # Импорт здесь же: torch тяжёлый, пусть весь старт идёт в фоновом потоке.
        from sentence_transformers import SentenceTransformer

        _model = SentenceTransformer(EMBED_MODEL, device=EMBED_DEVICE)
    except Exception as e:  # noqa: BLE001 — статус ошибки показываем в /health
        _model_error = f"{type(e).__name__}: {e}"
    finally:
        _model_loading = False


threading.Thread(target=_load_model, daemon=True).start()

# --- Chroma: ленивый HTTP-клиент ---------------------------------------------

_chroma = None


def chroma():
    """Лениво поднимает (и переиспользует) клиент к серверу Chroma."""
    global _chroma
    if _chroma is None:
        import chromadb

        _chroma = chromadb.HttpClient(host=CHROMA_HOST, port=CHROMA_PORT)
    return _chroma


# --- Эмбеддинг ---------------------------------------------------------------


def embed(texts: list[str], mode: str) -> list[list[float]]:
    """Тексты → векторы. mode='document' для записи, mode='query' для поиска.

    У FRIDA в конфиге sentence-transformers уже прописаны промпты-префиксы
    («search_document: », «search_query: »), поэтому достаточно prompt_name.
    Для модели без таких промптов добавляем префикс руками — поведение то же.
    """
    if _model_error:
        raise HTTPException(503, f"модель не загрузилась: {_model_error}")
    if _model is None:
        raise HTTPException(503, "модель ещё грузится — смотри GET /health")

    prompt_name = "search_document" if mode == "document" else "search_query"
    with _encode_lock:
        try:
            vecs = _model.encode(
                texts, prompt_name=prompt_name, normalize_embeddings=True
            )
        except (KeyError, ValueError):
            prefixed = [f"{prompt_name}: {t}" for t in texts]
            vecs = _model.encode(prefixed, normalize_embeddings=True)
    return [[float(x) for x in v] for v in vecs]


# --- Схемы запросов ------------------------------------------------------------


class VectorizeItem(BaseModel):
    id: str
    document: str
    # Chroma принимает в метаданных только str/int/float/bool.
    metadata: dict[str, str | int | float | bool] = Field(default_factory=dict)


class VectorizeBody(BaseModel):
    collection: str
    items: list[VectorizeItem]


class RetrieveBody(BaseModel):
    collection: str
    query: str
    top_k: int = 5


# --- Эндпоинты -----------------------------------------------------------------
# Все обработчики — обычные def: FastAPI выполняет их в тредпуле, и блокирующий
# PyTorch не стопорит event loop.


@app.get("/health")
def health() -> dict:
    """Готовность модели и доступность Chroma — фронт опрашивает до зелёного."""
    info: dict = {
        "model": EMBED_MODEL,
        "device": EMBED_DEVICE,
        "model_ready": _model is not None,
        "model_loading": _model_loading,
        "model_error": _model_error,
        "dim": _model.get_sentence_embedding_dimension() if _model else None,
    }
    try:
        chroma().heartbeat()
        info["chroma_ok"] = True
    except Exception as e:  # noqa: BLE001
        info["chroma_ok"] = False
        info["chroma_error"] = f"{type(e).__name__}: {e}"
    return info


@app.post("/vectorize")
def vectorize(body: VectorizeBody) -> dict:
    """Документы → FRIDA(search_document) → upsert в коллекцию Chroma."""
    if not body.items:
        raise HTTPException(400, "items пуст")
    if len(body.items) > MAX_ITEMS:
        raise HTTPException(400, f"не больше {MAX_ITEMS} документов за запрос")

    vectors = embed([it.document for it in body.items], mode="document")

    try:
        col = chroma().get_or_create_collection(
            body.collection,
            metadata={"hnsw:space": "cosine"},  # косинусная близость
        )
        col.upsert(
            ids=[it.id for it in body.items],
            embeddings=vectors,
            documents=[it.document for it in body.items],
            # Метаданные в Chroma не могут быть пустым словарём.
            metadatas=[it.metadata or {"source": body.collection} for it in body.items],
        )
    except HTTPException:
        raise
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Chroma: {type(e).__name__}: {e}")

    return {
        "model": EMBED_MODEL,
        "collection": body.collection,
        "dim": len(vectors[0]),
        "count": len(vectors),
        "vectors": vectors,  # отдаём целиком — фронт показывает их как «результат»
    }


@app.post("/retrieve")
def retrieve(body: RetrieveBody) -> dict:
    """Строка запроса → FRIDA(search_query) → ближайшие документы из Chroma."""
    if not body.query.strip():
        raise HTTPException(400, "query пуст")

    try:
        col = chroma().get_collection(body.collection)
    except Exception:  # noqa: BLE001 — клиент кидает своё исключение, для нас это 404
        raise HTTPException(404, f"коллекции '{body.collection}' нет — сначала /vectorize")

    query_vector = embed([body.query], mode="query")[0]

    try:
        total = col.count()
        hits: list[dict] = []
        if total > 0:
            n = max(1, min(body.top_k, TOP_K_MAX, total))
            res = col.query(
                query_embeddings=[query_vector],
                n_results=n,
                include=["documents", "metadatas", "distances"],
            )
            for i, doc_id in enumerate(res["ids"][0]):
                distance = res["distances"][0][i]
                hits.append(
                    {
                        "id": doc_id,
                        "document": res["documents"][0][i],
                        "metadata": res["metadatas"][0][i],
                        "distance": distance,
                        # space=cosine ⇒ distance = 1 − cos_sim, возвращаем и близость
                        "similarity": 1.0 - distance,
                    }
                )
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Chroma: {type(e).__name__}: {e}")

    return {
        "model": EMBED_MODEL,
        "collection": body.collection,
        "query": body.query,
        "dim": len(query_vector),
        "query_vector": query_vector,
        "hits": hits,
    }


@app.get("/collections")
def collections() -> dict:
    """Список коллекций Chroma с количеством документов."""
    try:
        out = []
        for c in chroma().list_collections():
            # в разных версиях клиента приходит либо имя, либо объект коллекции
            name = c if isinstance(c, str) else c.name
            out.append({"name": name, "count": chroma().get_collection(name).count()})
        return {"collections": out}
    except Exception as e:  # noqa: BLE001
        raise HTTPException(502, f"Chroma: {type(e).__name__}: {e}")


@app.delete("/collections/{name}")
def delete_collection(name: str) -> dict:
    """Удалить коллекцию — чтобы полигон можно было начинать с чистого листа."""
    try:
        chroma().delete_collection(name)
    except Exception:  # noqa: BLE001
        raise HTTPException(404, f"коллекции '{name}' нет")
    return {"ok": True}
