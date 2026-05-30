/**
 * Бесплатные (без токена) парсеры GitHub.
 *
 * Ходит в публичный REST API GitHub без ключа (лимит — 60 запросов/час на IP) и
 * для КАЖДОГО репозитория, который уже лежит в таблице repos, выкачивает связанные
 * сущности: метаданные репо, коммиты, пул-реквесты, issues и релизы — и кладёт их
 * в соответствующие таблицы (upsert, без дублей).
 *
 * Никаких секретов: обязателен только User-Agent (этого требует GitHub).
 */
import { pool } from "./db";

const GH_API = "https://api.github.com";
const PER_PAGE = 100;
// Без ключа лимит жёсткий (60 req/час), поэтому не уходим глубже нескольких страниц.
const MAX_PAGES = 3;

const HEADERS = {
  "User-Agent": "demo-github-parser",
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
};

interface RepoRow {
  id: number;
  owner: string;
  name: string;
  // Докуда уже долистали по каждому типу — отсюда продолжаем (а не с начала).
  commits_deepest_page: number;
  pulls_deepest_page: number;
  issues_deepest_page: number;
  releases_deepest_page: number;
}

export interface SyncResult {
  repo: string;
  commits: number;
  pulls: number;
  issues: number;
  releases: number;
}

/** Один GET к GitHub. Бросает понятную ошибку на rate-limit / не-200. */
async function ghFetch(path: string): Promise<any> {
  const res = await fetch(`${GH_API}${path}`, { headers: HEADERS });

  // Пустой репозиторий — у списка коммитов GitHub отвечает 409. Это не ошибка.
  if (res.status === 409) return [];

  if (
    res.status === 403 &&
    res.headers.get("x-ratelimit-remaining") === "0"
  ) {
    const reset = res.headers.get("x-ratelimit-reset");
    const when = reset ? new Date(Number(reset) * 1000).toISOString() : "?";
    throw new Error(
      `GitHub rate limit исчерпан (без ключа — 60 запросов/час). Сброс: ${when}`,
    );
  }
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub ${res.status} на ${path}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

/**
 * Постранично собирает СЛЕДУЮЩИЕ MAX_PAGES страниц, начиная со страницы
 * startPage (= уже выкачанная глубина + 1). Возвращает строки и новую глубину
 * `lastPage` — её и надо сохранить, чтобы следующая выкачка пошла дальше, а не
 * повторила те же страницы. Если ничего нового нет, lastPage = startPage - 1.
 */
async function ghPaged(
  pathBase: string,
  startPage: number,
): Promise<{ items: any[]; lastPage: number }> {
  const items: any[] = [];
  let lastPage = startPage - 1; // пусто → глубина не выросла
  for (let i = 0; i < MAX_PAGES; i++) {
    const page = startPage + i;
    const sep = pathBase.includes("?") ? "&" : "?";
    const batch = await ghFetch(`${pathBase}${sep}per_page=${PER_PAGE}&page=${page}`);
    if (!Array.isArray(batch) || batch.length === 0) break;
    items.push(...batch);
    lastPage = page;
    if (batch.length < PER_PAGE) break; // дошли до конца истории
  }
  return { items, lastPage };
}

/** Выкачивает сущности для всех репозиториев из БД. */
export async function syncAll(): Promise<SyncResult[]> {
  const { rows } = await pool.query<RepoRow>(
    `SELECT id, owner, name,
            commits_deepest_page, pulls_deepest_page,
            issues_deepest_page, releases_deepest_page
       FROM repos ORDER BY id`,
  );
  const results: SyncResult[] = [];
  for (const repo of rows) {
    results.push(await syncRepo(repo));
  }
  return results;
}

async function syncRepo(repo: RepoRow): Promise<SyncResult> {
  const slug = `${repo.owner}/${repo.name}`;

  // Свежие метаданные репозитория.
  const meta = await ghFetch(`/repos/${slug}`);
  await pool.query(
    `UPDATE repos
        SET default_branch = $2, description = $3, stars = $4, forks = $5,
            open_issues = $6, pushed_at = $7, last_fetched_at = now()
      WHERE id = $1`,
    [
      repo.id,
      meta.default_branch ?? null,
      meta.description ?? null,
      meta.stargazers_count ?? null,
      meta.forks_count ?? null,
      meta.open_issues_count ?? null,
      meta.pushed_at ?? null,
    ],
  );

  const commits = await syncCommits(repo, slug);
  const pulls = await syncPulls(repo, slug);
  const issues = await syncIssues(repo, slug);
  const releases = await syncReleases(repo, slug);

  return { repo: slug, commits, pulls, issues, releases };
}

async function syncCommits(repo: RepoRow, slug: string): Promise<number> {
  const { items, lastPage } = await ghPaged(
    `/repos/${slug}/commits`,
    repo.commits_deepest_page + 1,
  );
  for (const c of items) {
    await pool.query(
      `INSERT INTO commits (sha, repo_id, message, author_login, author_name, committed_at, url)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (sha) DO UPDATE SET
         message = EXCLUDED.message, author_login = EXCLUDED.author_login,
         author_name = EXCLUDED.author_name, committed_at = EXCLUDED.committed_at,
         url = EXCLUDED.url`,
      [
        c.sha,
        repo.id,
        c.commit?.message ?? null,
        c.author?.login ?? null,
        c.commit?.author?.name ?? null,
        c.commit?.author?.date ?? null,
        c.html_url ?? null,
      ],
    );
  }
  await pool.query("UPDATE repos SET commits_deepest_page = $2 WHERE id = $1", [
    repo.id,
    lastPage,
  ]);
  return items.length;
}

async function syncPulls(repo: RepoRow, slug: string): Promise<number> {
  const { items, lastPage } = await ghPaged(
    `/repos/${slug}/pulls?state=all`,
    repo.pulls_deepest_page + 1,
  );
  for (const p of items) {
    await pool.query(
      `INSERT INTO pulls (repo_id, number, title, state, author_login, created_at, closed_at, merged_at, url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (repo_id, number) DO UPDATE SET
         title = EXCLUDED.title, state = EXCLUDED.state, author_login = EXCLUDED.author_login,
         created_at = EXCLUDED.created_at, closed_at = EXCLUDED.closed_at,
         merged_at = EXCLUDED.merged_at, url = EXCLUDED.url`,
      [
        repo.id,
        p.number,
        p.title ?? null,
        p.state ?? null,
        p.user?.login ?? null,
        p.created_at ?? null,
        p.closed_at ?? null,
        p.merged_at ?? null,
        p.html_url ?? null,
      ],
    );
  }
  await pool.query("UPDATE repos SET pulls_deepest_page = $2 WHERE id = $1", [
    repo.id,
    lastPage,
  ]);
  return items.length;
}

async function syncIssues(repo: RepoRow, slug: string): Promise<number> {
  const { items, lastPage } = await ghPaged(
    `/repos/${slug}/issues?state=all`,
    repo.issues_deepest_page + 1,
  );
  // Эндпоинт issues отдаёт и PR-ы — у них есть поле pull_request, их отбрасываем.
  const onlyIssues = items.filter((i) => !i.pull_request);
  for (const i of onlyIssues) {
    await pool.query(
      `INSERT INTO issues (repo_id, number, title, state, author_login, created_at, closed_at, url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (repo_id, number) DO UPDATE SET
         title = EXCLUDED.title, state = EXCLUDED.state, author_login = EXCLUDED.author_login,
         created_at = EXCLUDED.created_at, closed_at = EXCLUDED.closed_at, url = EXCLUDED.url`,
      [
        repo.id,
        i.number,
        i.title ?? null,
        i.state ?? null,
        i.user?.login ?? null,
        i.created_at ?? null,
        i.closed_at ?? null,
        i.html_url ?? null,
      ],
    );
  }
  await pool.query("UPDATE repos SET issues_deepest_page = $2 WHERE id = $1", [
    repo.id,
    lastPage,
  ]);
  return onlyIssues.length;
}

async function syncReleases(repo: RepoRow, slug: string): Promise<number> {
  const { items, lastPage } = await ghPaged(
    `/repos/${slug}/releases`,
    repo.releases_deepest_page + 1,
  );
  for (const r of items) {
    await pool.query(
      `INSERT INTO releases (repo_id, id, tag_name, name, published_at, url)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (repo_id, id) DO UPDATE SET
         tag_name = EXCLUDED.tag_name, name = EXCLUDED.name,
         published_at = EXCLUDED.published_at, url = EXCLUDED.url`,
      [
        repo.id,
        r.id,
        r.tag_name ?? null,
        r.name ?? null,
        r.published_at ?? null,
        r.html_url ?? null,
      ],
    );
  }
  await pool.query("UPDATE repos SET releases_deepest_page = $2 WHERE id = $1", [
    repo.id,
    lastPage,
  ]);
  return items.length;
}
