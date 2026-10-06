# TeleDrive Engineering Rules — Index

Detail lengkap ada di `.agents/rules/*.md` — baca semua sebelum coding.

1. Preserve UI/service/storage boundaries (lihat [.agents/rules/architecture.md](file:///d:/DEV/tele-drive/.agents/rules/architecture.md)).
2. Never expose Telegram credentials or user sessions to client or logs; sessions are stored encrypted only.
3. Never store binary files in the database (SQLite now, metadata only — ADR-012).
4. All storage operations must use `StorageAdapter`.
5. Large transfers must use streaming/workers (no full RAM buffering).
6. Every user resource requires authorization (row + peer level) — [.agents/rules/security.md](file:///d:/DEV/tele-drive/.agents/rules/security.md).
7. Respect Telegram rate limits / FLOOD_WAIT — [.agents/rules/telegram-mtproto.md](file:///d:/DEV/tele-drive/.agents/rules/telegram-mtproto.md).
8. File references must support refresh flow upon expiration.
9. TypeScript strict mode + Zod validation at all boundaries.
10. Tests required for business logic and release gates — [.agents/rules/testing.md](file:///d:/DEV/tele-drive/.agents/rules/testing.md).
11. No unrelated refactors.
12. MTProto session access only via `workers/telegram-connector`, hosted in a single server process (ADR-007 amended). One Telegram account per user, QR login only (ADR-011).
13. API list/search endpoints must be cursor-paginated — [.agents/rules/api-conventions.md](file:///d:/DEV/tele-drive/.agents/rules/api-conventions.md).
