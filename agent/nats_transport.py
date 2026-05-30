"""
Транспортный слой: вся работа с NATS и стриминг-конвертами.

Тут сосредоточено всё, что относится к доставке: подключение с ретраями, подписка
на сабжект запросов, парсинг входящего сообщения и отправка ответа обратно кусками
в формате {"type": "token"|"done"|"error", ...}. Агентная логика этого не видит.
"""

import asyncio
import json
from typing import Awaitable, Callable

from nats.aio.client import Client as NATS
from nats.aio.msg import Msg

# Обработчик стриминг-запроса: получает распарсенный dict и Responder для ответа.
RequestHandler = Callable[[dict, "Responder"], Awaitable[None]]

# Обработчик request-reply: dict на входе, dict на выходе (один ответ).
RpcHandler = Callable[[dict], Awaitable[dict]]


class Responder:
    """Отправляет ответ обратно в reply-сабжект конкретного запроса.

    Прячет формат конвертов — агентному коду остаётся только token()/done()/error().
    """

    def __init__(self, nc: NATS, subject: str) -> None:
        self._nc = nc
        self._subject = subject

    async def token(self, text: str) -> None:
        await self._send({"type": "token", "content": text})

    async def status(self, text: str) -> None:
        await self._send({"type": "status", "content": text})

    async def trace(self, text: str) -> None:
        await self._send({"type": "trace", "content": text})

    async def thinking(self, text: str) -> None:
        await self._send({"type": "thinking", "content": text})

    async def tool(self, name: str, arguments: dict, result: dict) -> None:
        await self._send(
            {"type": "tool", "name": name, "arguments": arguments, "result": result}
        )

    async def usage(self, tin: int, tout: int) -> None:
        await self._send({"type": "usage", "tin": tin, "tout": tout})

    async def snapshot(
        self, label: str, messages: list, output: str, tin: int, tout: int
    ) -> None:
        # Полный снимок одного вызова модели: вход целиком + ответ целиком.
        await self._send(
            {
                "type": "snapshot",
                "label": label,
                "messages": messages,
                "output": output,
                "tin": tin,
                "tout": tout,
            }
        )

    async def done(self) -> None:
        await self._send({"type": "done"})

    async def error(self, message: str) -> None:
        await self._send({"type": "error", "error": message})

    async def _send(self, obj: dict) -> None:
        # default=str — чтобы datetime и прочие нестандартные типы из результатов
        # инструментов сериализовались, а не роняли отправку.
        await self._nc.publish(self._subject, json.dumps(obj, default=str).encode())


async def connect_with_retry(url: str, attempts: int = 30) -> NATS:
    """Подключается к NATS с ретраями (agent может стартовать раньше шины)."""
    nc = NATS()
    for attempt in range(1, attempts + 1):
        try:
            await nc.connect(
                servers=[url],
                max_reconnect_attempts=-1,
                reconnect_time_wait=1,
                connect_timeout=5,
            )
            return nc
        except Exception as e:  # noqa: BLE001
            print(f"NATS connect failed (attempt {attempt}): {e}", flush=True)
            await asyncio.sleep(1)
    raise RuntimeError(f"could not connect to NATS at {url}")


async def serve_requests(nc: NATS, subject: str, handler: RequestHandler) -> None:
    """Подписывается на subject и на каждый запрос зовёт handler в своей задаче.

    На себя берёт: парсинг JSON, валидацию reply-сабжекта, конкурентность и
    превращение любого исключения из handler в событие {type: error} для фронта.
    """

    async def cb(msg: Msg) -> None:
        asyncio.create_task(_dispatch(nc, msg, handler))

    await nc.subscribe(subject, cb=cb)


async def serve_rpc(nc: NATS, subject: str, handler: RpcHandler) -> None:
    """Простой request-reply: на subject приходит запрос, handler возвращает dict,
    он уходит обратно в reply-сабжект. Используется для get/set системного промпта.

    Любое исключение из handler превращается в {"error": "..."} — вызывающая
    сторона (backend) получит понятный ответ, а не таймаут.
    """

    async def cb(msg: Msg) -> None:
        try:
            req = json.loads(msg.data.decode()) if msg.data else {}
            result = await handler(req)
        except Exception as e:  # noqa: BLE001
            result = {"error": f"{type(e).__name__}: {e}"}
        if msg.reply:
            await nc.publish(msg.reply, json.dumps(result).encode())

    await nc.subscribe(subject, cb=cb)


async def _dispatch(nc: NATS, msg: Msg, handler: RequestHandler) -> None:
    try:
        req = json.loads(msg.data.decode())
    except (json.JSONDecodeError, UnicodeDecodeError):
        return

    reply = req.get("reply")
    if not reply:
        return

    responder = Responder(nc, reply)
    try:
        await handler(req, responder)
    except Exception as e:  # noqa: BLE001 — любую ошибку отдаём на фронт
        await responder.error(f"{type(e).__name__}: {e}")
