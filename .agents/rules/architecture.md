# Architecture Rules

## 1. Boundary & Dependency Direction
- **UI / Client** (`apps/web/src`): runs in the browser and talks only to `/api` over HTTP with the session cookie. Never sees Telegram sessions, API hashes or storage identifiers beyond file ids.
- **Web & API** (`apps/web/server`, TypeScript run via Node type stripping): validates every input with Zod, authenticates via the `td_session` cookie, enforces row-level and peer-level authorization, and delegates to repositories, the connector and the worker. `createApp(deps)` is dependency-injected so tests run the real API without Telegram.
- **Metadata** (`packages/database`): SQLite via `node:sqlite`; repositories are the only place SQL lives (ADR-012).
- **Storage Layer** (`packages/storage`, `packages/telegram`): every byte goes through the `StorageAdapter` contract (`upload`, `download`, `delete`, `refreshReference`, `exists`). An adapter instance is bound to one user's storage peer.
- **Telegram connector** (`workers/telegram-connector`): the only code that creates MTProto clients. Holds one client per user (ADR-011), per-user FLOOD_WAIT windows and transfer slots, QR login, and encrypted session handling.
- **Storage worker** (`workers/storage-worker`): durable upload queue backed by the `jobs` table and spooled temp files; routes all transfers through the connector.

## 2. Component Boundaries
```
Browser / UI
  │ HTTPS (cookie: td_session, SameSite=Strict)
  ▼
Web & API (Express, single process)
  ├── SQLite (metadata, sessions, jobs)          packages/database
  ├── StorageWorker (durable job loop)           workers/storage-worker
  └── TelegramConnector (per-user client pool)   workers/telegram-connector
          ▼
      StorageAdapter (bound to user's channel)   packages/telegram
          ▼
      Telegram MTProto — user's OWN account, private "TeleDrive Storage" channel
```

## 3. Technology Principles
- One Telegram account per TeleDrive user; login is Telegram QR only (ADR-011).
- Binary files are never stored in the database; spooled temp files are deleted after transfer.
- Run exactly one server instance (ADR-007 amended). Scaling out requires moving the connector to its own process first.
- Storage providers stay replaceable through `StorageAdapter`.
