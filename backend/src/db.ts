/**
 * Бекендовая «смотрелка» Postgres (read-only).
 *
 * Пул соединений + белый список таблиц. Наружу торчат только эти таблицы, и у
 * каждой ЗАХАРДКОЖЕНА сортировка — имя таблицы и ORDER BY никогда не берутся из
 * пользовательского ввода, поэтому строковая подстановка в SQL тут безопасна.
 * Всё, что приходит от клиента (limit/offset), идёт через параметры запроса.
 */
import pg from "pg";

const { Pool } = pg;

const DATABASE_URL =
  process.env.DATABASE_URL ?? "postgresql://demo:demo@postgres:5432/demo";

export const pool = new Pool({ connectionString: DATABASE_URL });

// Имя таблицы → выражение ORDER BY. Ключи = единственные разрешённые таблицы.
export const ALLOWED_TABLES: Record<string, string> = {
  repos: "id",
  commits: "committed_at DESC NULLS LAST",
  pulls: "repo_id, number",
  issues: "repo_id, number",
  releases: "repo_id, id",
  events: "ts DESC",
};

export function isAllowed(table: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED_TABLES, table);
}

export interface ColumnInfo {
  name: string;
  type: string;
}

/** Колонки таблицы из information_schema (в порядке объявления). */
export async function listColumns(table: string): Promise<ColumnInfo[]> {
  const { rows } = await pool.query(
    `SELECT column_name, data_type
       FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position`,
    [table],
  );
  return rows.map((r) => ({ name: r.column_name, type: r.data_type }));
}

/** Число строк в таблице. */
export async function countRows(table: string): Promise<number> {
  // table — ключ белого списка, в SQL-идентификатор подставляем безопасно.
  const { rows } = await pool.query(`SELECT count(*)::int AS n FROM "${table}"`);
  return rows[0].n as number;
}

/** Страница строк таблицы. limit/offset — через параметры (без инъекций). */
export async function fetchRows(
  table: string,
  limit: number,
  offset: number,
): Promise<Record<string, unknown>[]> {
  const orderBy = ALLOWED_TABLES[table]; // тоже из белого списка
  const { rows } = await pool.query(
    `SELECT * FROM "${table}" ORDER BY ${orderBy} LIMIT $1 OFFSET $2`,
    [limit, offset],
  );
  return rows;
}
