"""
Хранилище системного промпта.

Промпт лежит в обычном текстовом файле РЯДОМ с рантаймом агента
(agent/system_prompt.txt) и читается оттуда на каждый запрос — так его можно
править из UI на лету, без пересборки контейнера. Если файла ещё нет, отдаём
дефолт (и не падаем).
"""

from pathlib import Path

# Файл рядом с этим модулем — то есть в каталоге агента.
PROMPT_PATH = Path(__file__).with_name("system_prompt.txt")

DEFAULT_PROMPT = "Ты — дружелюбный ассистент. Отвечай кратко и по делу."


def load_prompt() -> str:
    """Текущий системный промпт (или дефолт, если файла нет)."""
    try:
        return PROMPT_PATH.read_text(encoding="utf-8")
    except FileNotFoundError:
        return DEFAULT_PROMPT


def save_prompt(text: str) -> None:
    """Перезаписывает файл системного промпта."""
    PROMPT_PATH.write_text(text, encoding="utf-8")
