"""
Семантический поиск по векторной БД Chroma через сервис vectorizer.

Агент не грузит эмбеддер сам — только HTTP POST /retrieve. Коллекция pg_commits
заполняется на странице /vector (Postgres → FRIDA → Chroma).
"""

import os

import httpx

from .base import ToolResult, clamp, err, ok

VECTORIZER_URL = os.environ.get("VECTORIZER_URL", "http://vectorizer:9000")
COLLECTION = "pg_commits"

TOP_K_MIN, TOP_K_MAX = 1, 20
QUERY_WORDS_MIN, QUERY_WORDS_MAX = 2, 4
# Отсекаем явно нерелевантные совпадения после косинусного поиска.
MIN_SIMILARITY = 0.35


def _word_count(text: str) -> int:
    return len(text.split())


def _validate_hit(raw: object) -> dict | None:
    if not isinstance(raw, dict):
        return None
    doc_id = raw.get("id")
    document = raw.get("document")
    similarity = raw.get("similarity")
    if not isinstance(doc_id, str) or not doc_id.strip():
        return None
    if not isinstance(document, str) or not document.strip():
        return None
    try:
        score = float(similarity)
    except (TypeError, ValueError):
        return None
    if score < MIN_SIMILARITY:
        return None
    metadata = raw.get("metadata")
    if metadata is not None and not isinstance(metadata, dict):
        return None
    return {
        "id": doc_id,
        "document": document.strip(),
        "metadata": metadata or {},
        "similarity": round(score, 4),
    }


async def memory_search(query: str, top_k: int = 5) -> ToolResult:
    """Семантический поиск коммитов в Chroma по короткому запросу."""
    text = " ".join(str(query).split())
    if not text:
        return err("query пуст")

    words = _word_count(text)
    if words < QUERY_WORDS_MIN or words > QUERY_WORDS_MAX:
        return err(
            f"query должен быть коротким: {QUERY_WORDS_MIN}–{QUERY_WORDS_MAX} слова "
            f"(сейчас {words})"
        )

    top_k = clamp(int(top_k), TOP_K_MIN, TOP_K_MAX)
    payload = {"collection": COLLECTION, "query": text, "top_k": top_k}

    try:
        async with httpx.AsyncClient(timeout=httpx.Timeout(60.0)) as client:
            resp = await client.post(f"{VECTORIZER_URL}/retrieve", json=payload)
    except httpx.HTTPError as e:
        return err(f"vectorizer недоступен: {type(e).__name__}: {e}")

    if resp.status_code == 404:
        return err(
            f"коллекции '{COLLECTION}' нет — сначала векторизуй коммиты на /vector"
        )
    if resp.status_code == 503:
        detail = resp.json().get("detail", "модель ещё грузится")
        return err(f"vectorizer: {detail}")
    if resp.status_code != 200:
        try:
            detail = resp.json().get("detail", resp.text[:200])
        except Exception:  # noqa: BLE001
            detail = resp.text[:200]
        return err(f"vectorizer {resp.status_code}: {detail}")

    try:
        data = resp.json()
    except ValueError:
        return err("vectorizer вернул не-JSON")

    raw_hits = data.get("hits")
    if not isinstance(raw_hits, list):
        return err("vectorizer: hits отсутствует или не список")

    validated = [_validate_hit(h) for h in raw_hits]
    hits = [h for h in validated if h is not None]
    hits.sort(key=lambda h: h["similarity"], reverse=True)

    return ok(
        {
            "collection": COLLECTION,
            "query": text,
            "count": len(hits),
            "hits": hits[:top_k],
        }
    )
