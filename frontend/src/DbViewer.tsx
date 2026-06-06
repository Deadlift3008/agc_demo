import { useEffect, useState } from "react";

const PAGE = 25;

interface Column {
  name: string;
  type: string;
}

interface TableInfo {
  name: string;
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

// Рендер ячейки: null → «—», объект → усечённый JSON, длинный текст —
// обрезаем и помещаем полную версию в title (тултип).
function renderCell(value: unknown): { text: string; title?: string } {
  if (value === null || value === undefined) return { text: "—" };
  if (typeof value === "object") {
    const json = JSON.stringify(value);
    return json.length > 80
      ? { text: json.slice(0, 80) + "…", title: json }
      : { text: json };
  }
  const s = String(value);
  return s.length > 120 ? { text: s.slice(0, 120) + "…", title: s } : { text: s };
}

export default function DbViewer() {
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [error, setError] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  const [page, setPage] = useState<TablePage | null>(null);
  const [loading, setLoading] = useState(false);
  const [syncing, setSyncing] = useState(false);
  const [syncMsg, setSyncMsg] = useState("");

  function loadTables() {
    return fetch("/api/db/tables")
      .then((r) => r.json())
      .then((d) => {
        if (d.error) setError(d.error);
        else setTables(d.tables);
      })
      .catch((e) => setError(String(e)));
  }

  useEffect(() => {
    loadTables();
  }, []);

  async function sync() {
    setSyncing(true);
    setSyncMsg("Качаю с GitHub…");
    setError("");
    try {
      const res = await fetch("/api/db/sync", { method: "POST" });
      const data = await res.json();
      if (!res.ok || data.error) {
        setSyncMsg("");
        setError(data.error ?? `Ошибка ${res.status}`);
        return;
      }
      // Короткая сводка по загруженным данным.
      const summary = (data.synced as Array<Record<string, number | string>>)
        .map(
          (s) =>
            `${s.repo}: ${s.commits} коммитов, ${s.pulls} PR, ${s.issues} issues, ${s.releases} релизов`,
        )
        .join("; ");
      setSyncMsg(`Готово — ${summary || "репозиториев в БД нет"}`);
      await loadTables();
      // Если таблица открыта — обновим её содержимое.
      if (open) loadPage(open, page?.offset ?? 0);
    } catch (e) {
      setSyncMsg("");
      setError(String(e));
    } finally {
      setSyncing(false);
    }
  }

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

  function toggle(name: string) {
    if (open === name) {
      setOpen(null);
      setPage(null);
      return;
    }
    setOpen(name);
    setPage(null);
    loadPage(name, 0);
  }

  return (
    <div className="db-page">
      <header className="topbar">
        <h1 className="title">База данных</h1>
        <div className="topbar-actions">
          <button
            type="button"
            className="ghost"
            onClick={sync}
            disabled={syncing}
          >
            {syncing ? "⤓ Качаю…" : "⤓ Выкачать с GitHub"}
          </button>
          <a className="ghost" href="/">
            ← К чату
          </a>
          <a className="ghost" href="/vector">
            ≋ Векторы
          </a>
          <a className="ghost" href="/memory">
            ✦ Chroma
          </a>
        </div>
      </header>

      {syncMsg && <div className="db-sync">{syncMsg}</div>}
      {error && <div className="db-error">{error}</div>}

      <div className="db-list">
        {tables.map((t) => {
          const isOpen = open === t.name;
          return (
            <div key={t.name} className="db-item">
              <button
                type="button"
                className="db-head"
                onClick={() => toggle(t.name)}
              >
                <span className="db-caret">{isOpen ? "▾" : "▸"}</span>
                <span className="db-name">{t.name}</span>
                <span className="db-meta">
                  {t.rowCount} строк · {t.columns.length} колонок
                </span>
              </button>

              {isOpen && (
                <div className="db-body">
                  {loading && !page && <div className="db-hint">Загрузка…</div>}
                  {page && page.name === t.name && (
                    <TableContent
                      page={page}
                      loading={loading}
                      onPrev={() =>
                        loadPage(t.name, Math.max(page.offset - PAGE, 0))
                      }
                      onNext={() => loadPage(t.name, page.offset + PAGE)}
                      onRefresh={() => loadPage(t.name, page.offset)}
                    />
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function TableContent({
  page,
  loading,
  onPrev,
  onNext,
  onRefresh,
}: {
  page: TablePage;
  loading: boolean;
  onPrev: () => void;
  onNext: () => void;
  onRefresh: () => void;
}) {
  const from = page.rowCount === 0 ? 0 : page.offset + 1;
  const to = page.offset + page.rows.length;
  const hasPrev = page.offset > 0;
  const hasNext = page.offset + page.rows.length < page.rowCount;

  return (
    <>
      <div className="db-toolbar">
        <span className="db-counter">
          {from}–{to} of {page.rowCount}
        </span>
        <div className="db-pager">
          <button type="button" onClick={onPrev} disabled={!hasPrev || loading}>
            ‹ Назад
          </button>
          <button type="button" onClick={onNext} disabled={!hasNext || loading}>
            Вперёд ›
          </button>
          <button type="button" onClick={onRefresh} disabled={loading}>
            ⟳ Обновить
          </button>
        </div>
      </div>

      <div className="db-table-wrap">
        <table className="db-table">
          <thead>
            <tr>
              {page.columns.map((c) => (
                <th key={c.name} title={c.type}>
                  {c.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {page.rows.map((row, i) => (
              <tr key={i}>
                {page.columns.map((c) => {
                  const { text, title } = renderCell(row[c.name]);
                  return (
                    <td key={c.name} title={title}>
                      {text}
                    </td>
                  );
                })}
              </tr>
            ))}
            {page.rows.length === 0 && (
              <tr>
                <td className="db-empty" colSpan={page.columns.length || 1}>
                  Нет строк
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </>
  );
}
