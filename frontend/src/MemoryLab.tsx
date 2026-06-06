import { useEffect, useState } from "react";
import { EmbedderStatus, useEmbedderHealth } from "./EmbedderStatus";
import { VectorPreview } from "./VectorLab";

// Страница /memory — retrieve из «памяти» (Chroma).
// Текстовый запрос векторизуется той же FRIDA, но с префиксом search_query —
// и Chroma возвращает ближайшие по косинусной близости документы,
// которые были положены туда на странице /vector.

interface CollectionInfo {
  name: string;
  count: number;
}

interface Hit {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  distance: number;
  similarity: number;
}

interface RetrieveResult {
  model: string;
  collection: string;
  query: string;
  dim: number;
  query_vector: number[];
  hits: Hit[];
}

export default function MemoryLab() {
  const health = useEmbedderHealth();
  const [collections, setCollections] = useState<CollectionInfo[]>([]);
  const [collection, setCollection] = useState("");
  const [query, setQuery] = useState("");
  const [topK, setTopK] = useState(5);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<RetrieveResult | null>(null);

  async function loadCollections() {
    try {
      const res = await fetch("/api/memory/collections");
      const data = (await res.json()) as {
        collections?: CollectionInfo[];
        error?: string;
      };
      if (!res.ok || data.error) {
        setError(data.error ?? `Ошибка ${res.status}`);
        return;
      }
      setError("");
      setCollections(data.collections ?? []);
      // Если текущая коллекция исчезла (или ещё не выбрана) — выберем первую.
      if (!data.collections?.some((c) => c.name === collection)) {
        setCollection(data.collections?.[0]?.name ?? "");
      }
    } catch (e) {
      setError(String(e));
    }
  }

  useEffect(() => {
    loadCollections();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function retrieve(e: React.FormEvent) {
    e.preventDefault();
    if (!collection || !query.trim() || busy) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/memory/retrieve", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ collection, query, topK }),
      });
      const data = (await res.json()) as RetrieveResult & { error?: string };
      if (!res.ok || data.error) setError(data.error ?? `Ошибка ${res.status}`);
      else setResult(data);
    } catch (e2) {
      setError(String(e2));
    } finally {
      setBusy(false);
    }
  }

  async function clearCollection() {
    if (!collection) return;
    if (!window.confirm(`Удалить коллекцию «${collection}» из Chroma?`)) return;
    try {
      const res = await fetch(
        `/api/memory/collections/${encodeURIComponent(collection)}`,
        { method: "DELETE" },
      );
      const data = (await res.json()) as { error?: string };
      if (!res.ok || data.error) setError(data.error ?? `Ошибка ${res.status}`);
      else {
        setResult(null);
        await loadCollections();
      }
    } catch (e) {
      setError(String(e));
    }
  }

  const ready = Boolean(health?.model_ready && health?.chroma_ok);

  return (
    <div className="db-page">
      <header className="topbar">
        <h1 className="title">Память · retrieve из Chroma</h1>
        <div className="topbar-actions">
          <a className="ghost" href="/">
            ← К чату
          </a>
          <a className="ghost" href="/db">
            ⛁ БД
          </a>
          <a className="ghost" href="/vector">
            ≋ Векторы
          </a>
        </div>
      </header>

      <div className="lab-body">
        <EmbedderStatus health={health} />
        {error && <div className="db-error">{error}</div>}

        <div className="lab-panel">
          <div className="lab-step-title">Коллекция (память)</div>
          <div className="lab-row">
            <select
              value={collection}
              onChange={(e) => setCollection(e.target.value)}
            >
              {collections.length === 0 && (
                <option value="">— коллекций пока нет —</option>
              )}
              {collections.map((c) => (
                <option key={c.name} value={c.name}>
                  {c.name} ({c.count} документов)
                </option>
              ))}
            </select>
            <button type="button" className="ghost" onClick={loadCollections}>
              ⟳ Обновить
            </button>
            <button
              type="button"
              className="ghost"
              onClick={clearCollection}
              disabled={!collection}
            >
              ✕ Удалить коллекцию
            </button>
          </div>
          {collections.length === 0 && (
            <div className="lab-hint">
              Память пуста. Сначала положи в неё документы на странице{" "}
              <a href="/vector">/vector</a>.
            </div>
          )}
        </div>

        <div className="lab-panel">
          <div className="lab-step-title">Поиск по смыслу</div>
          <form onSubmit={retrieve} className="lab-row">
            <input
              className="input mem-query"
              type="text"
              placeholder="например: fix memory leak after reconnect"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
            <label className="lab-topk">
              top-k
              <input
                type="number"
                min={1}
                max={20}
                value={topK}
                onChange={(e) => setTopK(Number(e.target.value) || 5)}
              />
            </label>
            <button
              className="save"
              type="submit"
              disabled={!ready || busy || !collection || !query.trim()}
            >
              {busy ? "Ищу…" : "Найти"}
            </button>
          </form>
          <div className="lab-hint">
            Запрос векторизуется FRIDA с префиксом{" "}
            <code>search_query:&nbsp;</code> и сравнивается с векторами
            документов по косинусной близости.
          </div>
        </div>

        {result && (
          <div className="lab-panel">
            <div className="lab-step-title">
              Вектор запроса · модель {result.model} · размерность {result.dim}
            </div>
            <VectorPreview vector={result.query_vector} />
          </div>
        )}

        {result && (
          <div className="lab-panel">
            <div className="lab-step-title">
              Найдено: {result.hits.length} (из «{result.collection}»)
            </div>
            {result.hits.length === 0 && (
              <div className="lab-hint">Коллекция пуста.</div>
            )}
            {result.hits.map((h, i) => (
              <div key={h.id} className="vec-card">
                <div className="vec-card-head">
                  <span className="hit-rank">#{i + 1}</span>
                  <code>{h.id}</code>
                  <span className="hit-score">
                    similarity {h.similarity.toFixed(4)} · distance{" "}
                    {h.distance.toFixed(4)}
                  </span>
                </div>
                <div className="sim-bar">
                  <div
                    className="sim-bar-fill"
                    style={{
                      width: `${Math.round(Math.max(0, Math.min(1, h.similarity)) * 100)}%`,
                    }}
                  />
                </div>
                <pre className="ctx-msg-body">{h.document}</pre>
                <div className="lab-hint">
                  metadata: <code>{JSON.stringify(h.metadata)}</code>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
