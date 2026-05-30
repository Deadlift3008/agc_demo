"""
Read-only инструменты поверх Postgres.

Принципы (тот же подход, что и у бекендового модуля просмотра db.ts):
  • только SELECT, никакого произвольного SQL от модели;
  • таблицы, колонки и сортировка жёстко заданы в этом файле;
  • от модели приходят только limit/offset, и те ограничиваются безопасным диапазоном.

DATABASE_URL уже прокидывается в контейнер агента (docker-compose), так что пул
поднимается лениво при первом вызове любого инструмента.
"""

import os

import asyncpg

from .base import ToolResult, clamp, ok

# limit ограничиваем диапазоном [1, 50], offset — неотрицательный. Этого достаточно
# для демо и защищает от запроса модели на чрезмерно большое число строк.
LIMIT_MIN, LIMIT_MAX = 1, 50

_pool: asyncpg.Pool | None = None


async def _get_pool() -> asyncpg.Pool:
    """Лениво поднимает (и переиспользует) пул соединений к Postgres."""
    global _pool
    if _pool is None:
        dsn = os.environ.get(
            "DATABASE_URL", "postgresql://demo:demo@postgres:5432/demo"
        )
        _pool = await asyncpg.create_pool(dsn=dsn, min_size=1, max_size=4)
    return _pool


def _rows(records: list[asyncpg.Record]) -> list[dict]:
    """asyncpg.Record → обычный dict (для JSON-сериализации в наблюдение)."""
    return [dict(r) for r in records]


async def pg_list_issues(limit: int = 10, offset: int = 0) -> ToolResult:
    """Список issues репозитория, свежие сверху."""
    limit = clamp(int(limit), LIMIT_MIN, LIMIT_MAX)
    offset = max(int(offset), 0)
    pool = await _get_pool()
    records = await pool.fetch(
        """
        SELECT repo_id, number, title, state, author_login, created_at, closed_at, url
          FROM issues
         ORDER BY created_at DESC NULLS LAST, number DESC
         LIMIT $1 OFFSET $2
        """,
        limit,
        offset,
    )
    return ok(_rows(records))


async def pg_list_commits(limit: int = 10, offset: int = 0) -> ToolResult:
    """Список коммитов репозитория, свежие сверху."""
    limit = clamp(int(limit), LIMIT_MIN, LIMIT_MAX)
    offset = max(int(offset), 0)
    pool = await _get_pool()
    records = await pool.fetch(
        """
        SELECT sha, repo_id, message, author_login, author_name, committed_at, url
          FROM commits
         ORDER BY committed_at DESC NULLS LAST
         LIMIT $1 OFFSET $2
        """,
        limit,
        offset,
    )
    return ok(_rows(records))


async def pg_get_repo() -> ToolResult:
    """Информация о репозитории (в демо он один)."""
    pool = await _get_pool()
    record = await pool.fetchrow(
        """
        SELECT id, owner, name, default_branch, description,
               stars, forks, open_issues, pushed_at
          FROM repos
         ORDER BY id
         LIMIT 1
        """
    )
    return ok(dict(record) if record is not None else None)
