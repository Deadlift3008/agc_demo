"""
Низкоуровневый клиент OpenRouter.

Голый кастом, без LLM-SDK: дёргаем HTTP API напрямую через httpx со stream=True
и руками парсим SSE-поток. Это «механика под капотом» — выше по стеку (agent.py)
её уже не видно, там просто `async for token in stream_chat(...)`.
"""

import json
import os
from typing import AsyncIterator

import httpx

OPENROUTER_API_KEY = os.environ["OPENROUTER_API_KEY"]
OPENROUTER_URL = "https://openrouter.ai/api/v1/chat/completions"

_HEADERS = {
    "Authorization": f"Bearer {OPENROUTER_API_KEY}",
    "Content-Type": "application/json",
    # Эти два заголовка OpenRouter рекомендует, но не требует.
    "HTTP-Referer": "http://localhost:5173",
    # Только ASCII/Latin-1: значение HTTP-заголовка — кириллица здесь уронит
    # запрос с UnicodeEncodeError. Это лишь метка в аналитике OpenRouter.
    "X-Title": "Course Demo",
}


async def stream_chat(
    messages: list[dict],
    model: str,
    temperature: float | None = None,
    top_p: float | None = None,
) -> AsyncIterator[dict]:
    """Стримит ответ модели событиями-словарями:

      {"type": "delta", "text": "..."}                       — кусок текста;
      {"type": "usage", "prompt_tokens": N, "completion_tokens": M}
                                                              — точный расход.

    Usage приходит в самом конце (просим его через stream_options.include_usage);
    если провайдер его не пришлёт — событие usage просто не возникнет, и вызывающий
    код останется со своей оценкой. Бросает RuntimeError при не-200.
    """
    payload: dict = {
        "model": model,
        "messages": messages,
        "stream": True,
        # Просим вернуть точный расход токенов финальным чанком стрима.
        "stream_options": {"include_usage": True},
    }
    # Параметры кладём только если их явно передали (иначе — дефолты модели).
    if temperature is not None:
        payload["temperature"] = temperature
    if top_p is not None:
        payload["top_p"] = top_p

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
        async with client.stream(
            "POST", OPENROUTER_URL, headers=_HEADERS, json=payload
        ) as resp:
            if resp.status_code != 200:
                body = (await resp.aread()).decode(errors="replace")
                raise RuntimeError(f"OpenRouter {resp.status_code}: {body[:500]}")

            # SSE: строки вида "data: {...}" и финальная "data: [DONE]".
            async for line in resp.aiter_lines():
                if not line or line.startswith(":"):
                    continue  # пустые строки и комментарии-кипэлайвы
                if not line.startswith("data: "):
                    continue
                data = line[len("data: ") :]
                if data.strip() == "[DONE]":
                    break
                try:
                    chunk = json.loads(data)
                except json.JSONDecodeError:
                    continue
                delta = (chunk.get("choices") or [{}])[0].get("delta", {})
                content = delta.get("content")
                if content:
                    yield {"type": "delta", "text": content}
                usage = chunk.get("usage")
                if usage:
                    yield {
                        "type": "usage",
                        "prompt_tokens": usage.get("prompt_tokens", 0),
                        "completion_tokens": usage.get("completion_tokens", 0),
                    }


async def complete_chat(
    messages: list[dict],
    model: str,
    temperature: float | None = None,
    top_p: float | None = None,
) -> str:
    """Один НЕстриминговый вызов модели — возвращает весь ответ целиком.

    Нужен для «служебных» шагов ReAct/Plan-Execute, где модель должна вернуть
    JSON-решение (вызов инструмента или план), а не текст для пользователя.
    """
    payload: dict = {"model": model, "messages": messages, "stream": False}
    if temperature is not None:
        payload["temperature"] = temperature
    if top_p is not None:
        payload["top_p"] = top_p

    async with httpx.AsyncClient(timeout=httpx.Timeout(120.0)) as client:
        resp = await client.post(OPENROUTER_URL, headers=_HEADERS, json=payload)
        if resp.status_code != 200:
            raise RuntimeError(f"OpenRouter {resp.status_code}: {resp.text[:500]}")
        body = resp.json()
        return (body.get("choices") or [{}])[0].get("message", {}).get("content", "")
