# Database Rules

## 1. Engine & Migrations
- SQLite through Node's built-in `node:sqlite` (`packages/database/src/db.ts`), WAL mode, `foreign_keys = ON`.
- Schema changes are appended to `MIGRATIONS` (tracked by `PRAGMA user_version`). Never edit a shipped migration.
- Multi-statement changes go through `Database.transaction()`.
- Paths resolve from the repository root (`DATABASE_PATH`, default `data/teledrive.sqlite`), never from `process.cwd()`.

## 2. Metadata Only
- Store object definitions, sizes, MIME types, checksums and Telegram identifiers (`peer_id`, `message_id`, `document_id`, `access_hash`, `file_reference`, `dc_id`).
- Never store file bytes or base64 payloads. MTProto sessions are stored only as AES-256-GCM ciphertext (`users.session_enc`).

## 3. Tables
- `users`: one row per Telegram account (`telegram_user_id` unique), encrypted session, storage channel (`storage_channel_id`, `storage_access_hash`).
- `sessions`: TeleDrive login sessions (only the SHA-256 of the token is stored).
- `folders`: self-referencing tree. Moves must reject cycles (`assertNotDescendant`).
- `files`, `telegram_objects` (1-to-1 with files), `favorites`, `jobs` (durable upload queue with `temp_path`, `run_after`, `attempts`).

## 4. Trash Semantics
- Soft delete sets `deleted_at` and `trash_root_id` = the id of the item the user deleted. Deleting a folder marks its whole active subtree with that root.
- The trash lists only roots (`trash_root_id = id`). Restoring a root restores exactly the rows with that `trash_root_id`; items trashed separately stay trashed. If the original parent is not active, the item is restored to the root (folder names get a " (n)" suffix on clashes).
- Permanent deletion: `planPurge` → delete messages via the connector → `executePurge`. If Telegram deletion fails, no rows are removed.

## 5. Queries
- Every query on user data includes `user_id = ?` (or joins through `files.user_id`).
- Lists are keyset-paginated (`(sort_key, id)` cursors); no OFFSET.
- `LIKE` searches escape `%`, `_` and `\` (`escapeLike`).
