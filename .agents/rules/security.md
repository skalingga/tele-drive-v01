# Security Rules

## 1. Dual-Layer Ownership & Isolation (Row + Peer)
- Every file/folder/job lookup is scoped to the authenticated `user_id`. Never trust user ids from params, query strings or bodies.
- Peer level: each user's files live in a private channel inside their **own** Telegram account (ADR-011). Before streaming, the API checks `telegram_objects.peer_id` equals the user's storage channel; adapters refuse objects from any other peer.

## 2. Credentials & Sessions
- `TELEGRAM_API_ID`, `TELEGRAM_API_HASH` and `TELEGRAM_SESSION_ENCRYPTION_KEY` are server-only.
- User MTProto sessions are encrypted at rest (AES-256-GCM, `SessionCrypto`), decrypted only inside the connector, never logged, never sent to the client. Logout of a user's last TeleDrive session calls `auth.logOut` and wipes the stored session; Telegram-side revocation (`AUTH_KEY_UNREGISTERED`, `SESSION_REVOKED`…) does the same automatically.
- TeleDrive auth is a random token in the `td_session` cookie (`HttpOnly`, `SameSite=Strict`, `Secure` in production). Tokens are never returned in response bodies and bearer headers are not accepted. Only the SHA-256 hash is stored.
- QR login attempts are bound to the initiating browser by a random secret in the `td_qr` cookie.

## 3. Input Validation & Content Safety
- All inputs pass strict Zod schemas (ids are format-checked, names reject separators/control chars/dot-only).
- Uploaded names go through `sanitizeFileName`.
- Downloads: only inert types (raster images, audio/video, PDF, text/plain) are served inline; everything else is `application/octet-stream` + `attachment`. All content responses send `X-Content-Type-Options: nosniff` and (except PDF) a `sandbox` CSP. SVG is previewed as text, never rendered.
- State-changing requests with a foreign `Origin` are rejected (CSRF defence in depth).
- 500 responses never include internal error messages.

## 4. Resource Limits
- Uploads are spooled to disk (multer v2 disk storage), limited by `MAX_UPLOAD_MB`, max 50 open jobs per user.
- Downloads are streamed with exact HTTP Range handling (416 for unsatisfiable ranges); max 6 concurrent downloads and 3 concurrent uploads per user.
- Rate limits: QR start 20/10 min per IP, 2FA password 10/10 min per IP, API 600/min per user.
