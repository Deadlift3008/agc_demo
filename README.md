Архитектура такая:
- `frontend/` — UI на React/TypeScript
- `backend/` — HTTP API на TypeScript/Fastify
- `nats` — шина сообщений между backend и агентом
- `postgres` — база с данными по репозиторию

все выше - фактически обвязка для агентной логики:
- `agent/` — агентный runtime на Python (можно сделай любой свой)

Бэк на TS умеет скрейпить кусочек данных из GitHub-репозитория в Postgres, то есть наполнять БД. Дальше задача агента — научиться обращаться к этой БД через tools. То есть tool здесь - обычный read-only контракт поверх данных.

Где смотреть:
- `backend/src/github.ts` — скрейпинг GitHub в БД ()
- `backend/src/db.ts` — read-only просмотр таблиц
- `agent/agent.py` — режимы `llm`, `react`, `plan_execute`
- `agent/tools/registry.py` — реестр инструментов
- `agent/tools/postgres.py` — сами Postgres tools
- `frontend/src/App.tsx` — визуализация запуска агента, токенов, контекста и tool calls

Код специально написан под визуальное демо, поэтому там много комментариев, статусов и вывода в UI, это ок, сейчас главное понять суть как это все устроено внутри.
