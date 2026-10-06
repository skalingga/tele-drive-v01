# Testing & Release Gate Rules

## 1. How Tests Run
- `npm test` builds the workspace packages, then runs `node --test "tests/**/*.test.js"`.
- Tests are self-contained: `tests/helpers/harness.js` starts the real API (`createApp`) on an ephemeral port with in-memory SQLite, `MockStorageAdapter` per user and a fake QR provider. Never depend on a server running on a fixed port or on real Telegram.

## 2. Test Levels
- **Unit** (`tests/unit`): Zod schemas, cursors, filename sanitization, Range parsing, content-type policy, session encryption, storage adapters (incl. Telegram range alignment with a fake client), error mapping, connector/worker reliability.
- **Integration** (`tests/integration`): repositories on SQLite — folder cycles, trash/restore semantics, keyset pagination under concurrent changes, job queue recovery.
- **Security** (`tests/security`): cross-user IDOR on every endpoint (files, folders, jobs, trash), peer-level refusal, CSRF, XSS-safe content headers, QR attempt binding, validation, error leakage.
- **E2E** (`tests/e2e`): QR login → folders → upload → ranges → rename/move/favorite → search → pagination → trash/restore → permanent delete → logout.
- Every fixed bug gets a regression test.

## 3. Release Gate Checklist
1. User isolation verified at row and peer level.
2. Uploads never buffer whole files in memory; downloads stream with correct Range semantics.
3. Cursor pagination returns stable results.
4. UI handles loading, error, empty and offline states.
5. `npm run typecheck` and `npm test` pass with 0 failures.
6. Manual check against real Telegram: QR login (with and without 2FA), upload, video seek, logout.
