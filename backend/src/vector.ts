/**
 * Векторный полигон: мост Postgres → эмбеддер (FRIDA) → Chroma.
 *
 * Роль backend здесь нарочно маленькая: достать выбранные строки из Postgres,
 * склеить из них текстовые документы и передать их сервису vectorizer (Python),
 * который делает эмбеддинги и говорит с Chroma. Никакой ML-логики в Node нет.
 *
 * Безопасность та же, что в db.ts: имена таблиц и колонок берутся только из
 * белых списков (VECTOR_TABLES + information_schema), от клиента в SQL попадают
 * лишь ЗНАЧЕНИЯ первичных ключей — и те через параметры запроса.
 */
import { pool } from "./db";

const VECTORIZER_URL =
  process.env.VECTORIZER_URL ?? "http://vectorizer:9000";

// Сколько строк можно векторизовать за один клик (зеркалит лимит vectorizer).
export const MAX_PKS = 50;

export interface VectorTableConfig {
  /** Колонки первичного ключа — по ним строка адресуется и попадает в id документа. */
  pk: string[];
  /** Колонки, из которых по умолчанию собирается текст документа. */
  textColumns: string[];
}

// Таблица → как из её строки сделать документ. Ключи = разрешённые таблицы.
export const VECTOR_TABLES: Record<string, VectorTableConfig> = {
  repos: { pk: ["id"], textColumns: ["name", "description"] },
  commits: { pk: ["sha"], textColumns: ["message"] },
  pulls: { pk: ["repo_id", "number"], textColumns: ["title"] },
  issues: { pk: ["repo_id", "number"], textColumns: ["title"] },
  releases: { pk: ["repo_id", "id"], textColumns: ["tag_name", "name"] },
  events: { pk: ["id"], textColumns: ["title", "body"] },
};

/** Имя коллекции Chroma для таблицы: pg_commits, pg_issues, … */
export function collectionFor(table: string): string {
  return `pg_${table}`;
}

/**
 * Достаёт строки по списку значений первичного ключа.
 * WHERE ("pk1"=$1 AND "pk2"=$2) OR (…) — колонки из конфига, значения через параметры.
 */
export async function fetchRowsByPk(
  table: string,
  pkCols: string[],
  pks: unknown[][],
): Promise<Record<string, unknown>[]> {
  const clauses: string[] = [];
  const values: unknown[] = [];
  for (const pk of pks) {
    const parts = pkCols.map((col, i) => {
      values.push(pk[i]);
      return `"${col}" = $${values.length}`;
    });
    clauses.push(`(${parts.join(" AND ")})`);
  }
  const { rows } = await pool.query(
    `SELECT * FROM "${table}" WHERE ${clauses.join(" OR ")}`,
    values,
  );
  return rows;
}

/** id документа в Chroma: «commits:abc123», «issues:1:42» — таблица + ключ. */
export function buildId(table: string, pkCols: string[], row: Record<string, unknown>): string {
  return [table, ...pkCols.map((c) => String(row[c]))].join(":");
}

/**
 * Текст документа: выбранные колонки в виде «колонка: значение» построчно.
 * Пустые/NULL значения пропускаем — им нечего добавить в смысл вектора.
 */
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

/** Метаданные документа: таблица + первичный ключ (Chroma: только str/int/float/bool). */
export function buildMetadata(
  table: string,
  pkCols: string[],
  row: Record<string, unknown>,
): Record<string, string | number> {
  const meta: Record<string, string | number> = { table };
  for (const col of pkCols) {
    const value = row[col];
    meta[col] = typeof value === "number" ? value : String(value);
  }
  return meta;
}

/**
 * HTTP-вызов сервиса vectorizer. Ошибки сети превращаем в 503, а формат ошибок
 * FastAPI ({detail: …}) приводим к нашему ({error: …}), чтобы фронт видел одно поле.
 */
export async function callVectorizer(
  path: string,
  init?: RequestInit,
): Promise<{ status: number; data: Record<string, unknown> }> {
  let res: Response;
  try {
    res = await fetch(`${VECTORIZER_URL}${path}`, init);
  } catch (err) {
    return {
      status: 503,
      data: { error: `vectorizer недоступен: ${String(err)}` },
    };
  }
  let data: Record<string, unknown> = {};
  try {
    data = (await res.json()) as Record<string, unknown>;
  } catch {
    data = {};
  }
  if (!res.ok && data.detail !== undefined && data.error === undefined) {
    data.error = String(data.detail);
  }
  return { status: res.status, data };
}
