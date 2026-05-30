"""
Базовые примитивы для инструментов агента.

Один тип результата на все инструменты — ToolResult, который сериализуется в
строго однотипный конверт {"ok", "data", "error"}. Так модель (и рантайм) всегда
видят одинаковую форму ответа, неважно, успех это или ошибка валидации.
"""

from dataclasses import dataclass
from typing import Any


@dataclass
class ToolResult:
    ok: bool
    data: Any = None
    error: str | None = None

    def to_dict(self) -> dict:
        return {"ok": self.ok, "data": self.data, "error": self.error}


def ok(data: Any) -> ToolResult:
    """Успешный результат с данными."""
    return ToolResult(ok=True, data=data, error=None)


def err(message: str) -> ToolResult:
    """Ошибка инструмента в том же конверте (data=None)."""
    return ToolResult(ok=False, data=None, error=message)


def clamp(value: int, lo: int, hi: int) -> int:
    """Зажимает значение в [lo, hi]. Используется для limit/offset."""
    return max(lo, min(hi, value))
