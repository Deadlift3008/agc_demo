import { useEffect, useState } from "react";
import { EmbedderStatus, useEmbedderHealth } from "./EmbedderStatus";

// Страница /vector — тренировочный полигон «Postgres → вектор».
// Шаги видны прямо в UI: выбрать таблицу → выбрать колонки для текста →
// отметить строки → нажать кнопку → увидеть документы и их векторы,
// которые при этом легли в коллекцию Chroma (искать их — на странице /memory).

const PAGE = 25;
const MAX_PKS = 50; // зеркалит лимит backend/vectorizer

interface Column {
  name: string;
  type: string;
}

interface VTable {
  name: string;
  pk: string[];
  textColumns: string[];
  collection: string;
  rowCount: number;
  columns: Column[];
}

interface TablePage {
  name: string;
  columns: Column[];
  rowCount: number;
  limit: number;
  offset: number;
  rows: Record<string, unknown>[];
}

interface VecItem {
  id: string;
  document: string;
  metadata: Record<string, unknown>;
  vector: number[];
}

interface VectorizeResult {
  collection: string;
  model: string;
  dim: number;
  count: number;
  skipped: string[];
  items: VecItem[];
}

// Ключ строки для чекбоксов = JSON значений первичного ключа.
// Его же потом парсим обратно и отправляем на backend как pks.
function rowKey(row: Record<string, unknown>, pk: string[]): string {
  return JSON.stringify(pk.map((c) => row[c]));
}

function renderCell(value: unknown): string {
  if (value === null || value === undefined) return "—";
  const s = typeof value === "object" ? JSON.stringify(value) : String(value);
  return s.length > 80 ? s.slice(0, 80) + "…" : s;
}

// Вектор: первые числа сразу, целиком — по клику.
export function VectorPreview({ vector }: { vector: number[] }) {
  if (vector.length === 0) return null;
  const head = vector
    .slice(0, 8)
    .map((x) => x.toFixed(4))
    .join(", ");
  return (
    <details className="vec-vector">
      <summary>
        [{head}, …] · {vector.length} чисел
      </summary>
      <pre>{JSON.stringify(vector.map((x) => Number(x.toFixed(6))))}</pre>
    </details>
  );
}

export default function VectorLab() {
  const health = useEmbedderHealth();
  const [tables, setTables] = useState<VTable[]>([]);
  const [table, setTable] = useState<VTable | null>(null);
  const [cols, setCols] = useState<Set<string>>(new Set());
  const [page, setPage] = useState<TablePage | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState<VectorizeResult | null>(null);

  useEffect(() => {
    fetch("/api/vector/tables")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setTables(d.tables);
      })
      .catch((e) => setError(String(e)));
  }, []);

  async function loadPage(name: string, offset: number) {
    setLoading(true);
    try {
      const res = await fetch(
        `/api/db/tables/${encodeURIComponent(name)}?limit=${PAGE}&offset=${offset}`,
      );
      const data = (await res.json()) as TablePage & { error?: string };
      if (data.error) setError(data.error);
      else setPage(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }

  function pickTable(name: string) {
    const t = tables.find((x) => x.name === name) ?? null;
    setTable(t);
    setPage(null);
    setSelected(new Set());
    setResult(null);
    setError("");
    if (t) {
      setCols(new Set(t.textColumns)); // дефолт — текстовые колонки из конфига
      loadPage(t.name, 0);
    }
  }

  function toggleCol(name: string) {
    setCols((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function toggleRow(key: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  // Выбрать/снять все строки текущей страницы (выбор с других страниц не трогаем).
  function togglePageRows() {
    if (!page || !table) return;
    const keys = page.rows.map((r) => rowKey(r, table.pk));
    const allSelected = keys.every((k) => selected.has(k));
    setSelected((prev) => {
      const next = new Set(prev);
      for (const k of keys) {
        if (allSelected) next.delete(k);
        else next.add(k);
      }
      return next;
    });
  }

  async function vectorize() {
    if (!table || selected.size === 0 || cols.size === 0) return;
    setBusy(true);
    setError("");
    setResult(null);
    try {
      const res = await fetch("/api/vector/vectorize", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          table: table.name,
          pks: Array.from(selected).map((k) => JSON.parse(k)),
          columns: Array.from(cols),
        }),
      });
      const data = (await res.json()) as VectorizeResult & { error?: string };
      if (!res.ok || data.error) setError(data.error ?? `Ошибка ${res.status}`);
      else setResult(data);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }

  const ready = Boolean(health?.model_ready && health?.chroma_ok);
  const canVectorize =
    ready && !busy && table !== null && selected.size > 0 && cols.size > 0;

  return (
    <div className="db-page">
      <header className="topbar">
        <h1 className="title">Векторизация · Postgres → FRIDA → Chroma</h1>
        <div className="topbar-actions">
          <a className="ghost" href="/">
            ← К чату
          </a>
          <a className="ghost" href="/db">
            ⛁ БД
          </a>
          <a className="ghost" href="/memory">
            ✦ Chroma
          </a>
        </div>
      </header>

      <div className="lab-body">
        <EmbedderStatus health={health} />
        {error && <div className="db-error">{error}</div>}

        {/* Шаг 1: таблица */}
        <div className="lab-panel">
          <div className="lab-step-title">1 · Таблица Postgres</div>
          <div className="lab-row">
            <select
              value={table?.name ?? ""}
              onChange={(e) => pickTable(e.target.value)}
            >
              <option value="" disabled>
                — выбери таблицу —
              </option>
              {tables.map((t) => (
                <option key={t.name} value={t.name}>
                  {t.name} ({t.rowCount} строк)
                </option>
              ))}
            </select>
            {table && (
              <span className="lab-hint">
                ключ строки: <code>{table.pk.join(" + ")}</code> · коллекция в
                Chroma: <code>{table.collection}</code>
              </span>
            )}
          </div>
        </div>

        {/* Шаг 2: какие колонки склеиваются в текст документа */}
        {table && (
          <div className="lab-panel">
            <div className="lab-step-title">2 · Колонки → текст документа</div>
            <div className="chips">
              {table.columns.map((c) => (
                <label
                  key={c.name}
                  className={`chip ${cols.has(c.name) ? "chip-on" : ""}`}
                  title={c.type}
                >
                  <input
                    type="checkbox"
                    checked={cols.has(c.name)}
                    onChange={() => toggleCol(c.name)}
                  />
                  {c.name}
                </label>
              ))}
            </div>
            <div className="lab-hint">
              Каждая строка превращается в документ вида{" "}
              <code>колонка: значение</code> (построчно). Перед эмбеддингом FRIDA
              добавит к нему префикс <code>search_document:&nbsp;</code>.
            </div>
          </div>
        )}

        {/* Шаг 3: строки */}
        {table && page && (
          <div className="lab-panel">
            <div className="lab-step-title">
              3 · Строки ({selected.size} выбрано
              {selected.size > MAX_PKS ? ` — максимум ${MAX_PKS}` : ""})
            </div>
            <div className="db-toolbar">
              <span className="db-counter">
                {page.rowCount === 0 ? 0 : page.offset + 1}–
                {page.offset + page.rows.length} of {page.rowCount}
              </span>
              <div className="db-pager">
                <button
                  type="button"
                  onClick={() => loadPage(table.name, Math.max(page.offset - PAGE, 0))}
                  disabled={page.offset === 0 || loading}
                >
                  ‹ Назад
                </button>
                <button
                  type="button"
                  onClick={() => loadPage(table.name, page.offset + PAGE)}
                  disabled={
                    page.offset + page.rows.length >= page.rowCount || loading
                  }
                >
                  Вперёд ›
                </button>
              </div>
            </div>

            <div className="db-table-wrap">
              <table className="db-table">
                <thead>
                  <tr>
                    <th>
                      <input
                        type="checkbox"
                        checked={
                          page.rows.length > 0 &&
                          page.rows.every((r) => selected.has(rowKey(r, table.pk)))
                        }
                        onChange={togglePageRows}
                      />
                    </th>
                    {page.columns.map((c) => (
                      <th key={c.name} title={c.type}>
                        {c.name}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {page.rows.map((row, i) => {
                    const key = rowKey(row, table.pk);
                    return (
                      <tr key={i}>
                        <td>
                          <input
                            type="checkbox"
                            checked={selected.has(key)}
                            onChange={() => toggleRow(key)}
                          />
                        </td>
                        {page.columns.map((c) => (
                          <td key={c.name}>{renderCell(row[c.name])}</td>
                        ))}
                      </tr>
                    );
                  })}
                  {page.rows.length === 0 && (
                    <tr>
                      <td className="db-empty" colSpan={page.columns.length + 1}>
                        Нет строк — сходи на /db и нажми «Выкачать с GitHub»
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            <div className="lab-actions">
              <button
                type="button"
                className="save"
                onClick={vectorize}
                disabled={!canVectorize || selected.size > MAX_PKS}
              >
                {busy
                  ? `Обрабатываю… (${(health?.device ?? "cpu").toUpperCase()})`
                  : `Векторизовать ${selected.size} строк → Chroma`}
              </button>
              {!ready && <span className="lab-hint">ждём эмбеддер…</span>}
            </div>
          </div>
        )}

        {/* Результат: документ + вектор бок о бок, и куда всё легло */}
        {result && (
          <div className="lab-panel">
            <div className="lab-step-title">
              Результат · {result.count} документов → коллекция{" "}
              <code>{result.collection}</code> · модель {result.model} ·
              размерность {result.dim}
            </div>
            {result.skipped.length > 0 && (
              <div className="lab-warn">
                Пропущено (пустой текст): {result.skipped.join(", ")}
              </div>
            )}
            {result.items.map((it) => (
              <div key={it.id} className="vec-card">
                <div className="vec-card-head">
                  <code>{it.id}</code>
                </div>
                <div className="vec-card-grid">
                  <div>
                    <div className="ctx-block-title">Документ (текст)</div>
                    <pre className="ctx-msg-body">{it.document}</pre>
                  </div>
                  <div>
                    <div className="ctx-block-title">Вектор (эмбеддинг)</div>
                    <VectorPreview vector={it.vector} />
                  </div>
                </div>
              </div>
            ))}
            <div className="lab-hint">
              Документы лежат в Chroma — теперь их можно достать по смыслу на
              странице <a href="/memory">/memory</a>.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
