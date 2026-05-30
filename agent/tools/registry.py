"""
Реестр инструментов.

Единая точка, через которую рантайм (ReAct / Plan-Execute) узнаёт, какие
инструменты есть, как их описать модели в промпте и как безопасно выполнить
вызов по имени. Сама модель никогда не дёргает функции напрямую — только просит
вызов по имени, а execute() валидирует имя, фильтрует аргументы и ловит ошибки.
"""

from dataclasses import dataclass, field
from typing import Awaitable, Callable

from .base import ToolResult, err
from .postgres import pg_get_repo, pg_list_commits, pg_list_issues


@dataclass
class Tool:
    name: str
    description: str
    # имя параметра → как он выглядит в подсказке модели (например, "limit:int=10")
    params: dict[str, str] = field(default_factory=dict)
    fn: Callable[..., Awaitable[ToolResult]] = None  # type: ignore[assignment]


TOOLS: dict[str, Tool] = {
    "pg_list_issues": Tool(
        name="pg_list_issues",
        description="список issues репозитория, свежие сверху",
        params={"limit": "limit:int=10", "offset": "offset:int=0"},
        fn=pg_list_issues,
    ),
    "pg_list_commits": Tool(
        name="pg_list_commits",
        description="список коммитов репозитория, свежие сверху",
        params={"limit": "limit:int=10", "offset": "offset:int=0"},
        fn=pg_list_commits,
    ),
    "pg_get_repo": Tool(
        name="pg_get_repo",
        description="информация о репозитории (owner, name, описание, статистика)",
        params={},
        fn=pg_get_repo,
    ),
}


def tools_description() -> str:
    """Человекочитаемый список инструментов для вставки в системный промпт."""
    lines = []
    for tool in TOOLS.values():
        sig = ", ".join(tool.params.values())
        lines.append(f"- {tool.name}({sig}) — {tool.description}")
    return "\n".join(lines)


async def execute(name: str, arguments: dict | None) -> ToolResult:
    """Безопасно выполняет инструмент по имени.

    Валидирует имя, отбрасывает неизвестные аргументы и превращает любое
    исключение в ToolResult с ok=False — рантайм просто кладёт это в наблюдение.
    """
    tool = TOOLS.get(name)
    if tool is None:
        return err(f"unknown tool '{name}'")

    args = arguments or {}
    if not isinstance(args, dict):
        return err("arguments must be an object")

    # Пропускаем только параметры, которые инструмент реально принимает.
    safe_args = {k: v for k, v in args.items() if k in tool.params}
    try:
        return await tool.fn(**safe_args)
    except (ValueError, TypeError) as e:
        return err(f"invalid arguments: {e}")
    except Exception as e:  # noqa: BLE001 — ошибку БД тоже отдаём в конверте
        return err(f"{type(e).__name__}: {e}")
