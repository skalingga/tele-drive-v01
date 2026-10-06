# ADR-001: Telegram MTProto as Storage via StorageAdapter
Status: Accepted
Context: We need large cloud file storage without hosting petabytes of expensive block storage.
Decision: Use Telegram MTProto (personal user account) accessed via a clean `StorageAdapter` interface.
Consequences: Storage is free and unlimited in capacity, but requires handling Telegram rate limits and session safety.

---

# ADR-002: PostgreSQL as Source of Truth for Metadata Only
Status: Accepted
Context: Binary storage in relational databases degrades I/O and balloons backup sizes.
Decision: Store all metadata (folders, files, mime types, checksums, Telegram message IDs) in PostgreSQL. Never store binaries in DB.
Consequences: Lean, fast database backups and queries.

---

# ADR-003: Large File Transfers via Queue & Storage Worker
Status: Accepted
Context: Synchronous HTTP file transfers can time out and block web server threads.
Decision: Offload heavy file transfers to background workers managed via BullMQ.
Consequences: Resilient async uploads with retry capabilities.

---

# ADR-004: UI Variants via Design Tokens & Modular Components
Status: Accepted
Context: Users expect modern dark/light themes and responsive desktop/mobile viewports.
Decision: Implement clean design tokens in Tailwind CSS with interchangeable grid and list views.
Consequences: Consistent visual identity with minimal boilerplate.

---

# ADR-005: Telegram Reference Recovery as Core Reliability Primitive
Status: Accepted
Context: Telegram file references expire after a period of time, breaking direct download links.
Decision: Implement automatic `refreshReference` flow in `StorageAdapter` to re-fetch message metadata when expired.
Consequences: Seamless long-term downloads for end users.

---

# ADR-006: Authorization at API and Service Boundaries
Status: Accepted
Context: Prevent IDOR vulnerabilities where users might tamper with IDs in URL paths.
Decision: Every repository query and service method enforces `WHERE user_id = :sessionUserId`.
Consequences: Multi-tenant security guarantee.

---

# ADR-007: MTProto Access via Single Telegram Connector Process
Status: Accepted
Context: Running MTProto client concurrently across multiple worker threads corrupts Telegram session sequence.
Decision: Run a single dedicated `telegram-connector` process. Workers communicate with it via serialized queue/channel.
Consequences: Rock-solid session integrity, preventing `401 AUTH_KEY_UNREGISTERED` errors.

---

# ADR-008: Peer-per-User Physical Isolation Model
Status: Accepted
Context: Row-level security alone could leak files if an authorization bug occurs in application code.
Decision: Provision an isolated Telegram channel/peer per registered user. Files are uploaded to the user's specific peer.
Consequences: Defense-in-depth isolation.

---

# ADR-009: No File-Level Encryption Beyond Session Key in MVP
Status: Accepted
Context: Client-side encryption prevents streaming previews of media and video transcoding.
Decision: Defer zero-knowledge client encryption to Post-MVP. Protect transport via HTTPS and session keys.
Consequences: Fast native in-browser previews for images, video, audio, and PDF.

---

# ADR-010: No Chunked Resumable Upload in MVP
Status: Accepted
Context: Chunking adds significant state complexity across MTProto parts.
Decision: Implement reliable single-stream transfers for MVP with retry on failure. Plan chunking for Post-MVP.
Consequences: Simpler MVP codebase with proven reliability for standard file transfers.

---

# ADR-011: One Telegram Account per User, Telegram-Only QR Login
Status: Accepted (2026-10-06) — supersedes ADR-008; amends ADR-001
Context: A single shared Telegram account holding every user's files concentrates ToS/ban risk (one ban loses all users' data) and its "peer per user" isolation was only a label.
Decision: Each TeleDrive user *is* one Telegram account. Login is exclusively Telegram QR login (`auth.exportLoginToken`, with 2FA via SRP). There are no email/password accounts. On first login TeleDrive creates a private channel "TeleDrive Storage" in the user's own account; all their files live there. The server uses one app `api_id/api_hash`; per-user MTProto sessions are stored AES-256-GCM encrypted (`TELEGRAM_SESSION_ENCRYPTION_KEY`) and wiped on logout (`auth.logOut`) or when Telegram reports the session revoked.
Consequences: Physical isolation per account; FLOOD_WAIT and bans are per user. Users grant TeleDrive full access to their Telegram account (like Telegram Desktop) — this is disclosed on the login page and revocable in Telegram → Settings → Devices. Encryption key loss/rotation logs everyone out.

---

# ADR-012: SQLite Metadata Store and Durable DB-Backed Job Queue (MVP)
Status: Accepted (2026-10-06) — amends ADR-002 and ADR-003
Context: The code used an in-memory JSON file (silent reset on corruption, lost writes) and an in-memory upload queue holding whole files in RAM. PostgreSQL/Redis existed only in docs and docker-compose.
Decision: Metadata lives in SQLite via Node's built-in `node:sqlite` (WAL, foreign keys, transactions, versioned migrations). Upload jobs are rows in the `jobs` table; payloads are spooled to `UPLOAD_TEMP_DIR` on disk and streamed to Telegram. On start, interrupted jobs are re-queued and orphaned temp files swept. Retries use exponential backoff and honour FLOOD_WAIT.
Consequences: Crash-safe single-node deployment with no external services. Repositories are the only SQL boundary, so moving to PostgreSQL later is contained to `packages/database`. Horizontal scaling is out of scope until then.

---

# ADR-007 (amended 2026-10-06): Single MTProto Owner Process
The connector (`workers/telegram-connector`) is a library hosted inside the single server process; it is the only code that creates gramjs clients (one pool entry per user). Run exactly one server instance. Splitting it into its own process requires an IPC/stream protocol and is deferred.
Amendment (download connections): a user's lane may hold several connections on the same session for downloads (`DownloadConnectionPool`), because Telegram throttles each connection. They all live in this one process, so the rule "a session is never used by two processes" is unchanged. Big downloads use only these pooled connections: sharing the main connection with them starved concurrent uploads (measured ~3 MB/s -> ~0.4 MB/s).
