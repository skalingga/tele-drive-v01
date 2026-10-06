# Telegram MTProto Rules

## 1. Adapter Contract
```ts
interface StorageAdapter {
  upload(input: UploadInput): Promise<StorageObject>;          // input.filePath — stream from disk
  download(object: StorageObject, options?: DownloadOptions): AsyncIterable<Buffer>;
  delete(objects: StorageObject[]): Promise<void>;
  refreshReference(object: StorageObject): Promise<StorageObject>;
  exists(object: StorageObject): Promise<boolean>;
}
```
An adapter is bound to one user's storage peer and must reject objects from other peers.

## 2. Accounts, Sessions & Login (ADR-011, ADR-007 amended)
- One Telegram account per TeleDrive user. Login = QR (`auth.exportLoginToken` → `UpdateLoginToken` → `LoginTokenSuccess`/`LoginTokenMigrateTo` → `importLoginToken`), plus `account.getPassword` + `auth.checkPassword` for 2FA.
- On first login create the private channel "TeleDrive Storage" (`channels.createChannel`, broadcast) and store its id/access hash.
- Only `workers/telegram-connector` creates gramjs clients, and only one server process runs it. A session must never be used by two processes.

## 3. Downloads, Ranges & Parallel Connections
- Do not use gramjs `iterDownload`: it caps requests at 512 KiB and fetches them one at a time.
- `TelegramStorageAdapter.download` calls `upload.getFile` directly with chunks that divide 1 MiB (default 256 KiB, offsets aligned to the chunk size, trimmed at both ends so any HTTP Range works). Chunks are requested in parallel and delivered strictly in order through a bounded prefetch window (memory per download = window x chunk).
- **Telegram limits throughput per connection** (measured: ~0.25 MB/s on one connection while the same machine downloads 3.6 MB/s from a CDN; 4 connections ~1.1 MB/s, 8 ~1.3 MB/s). Prefetching on one connection does not help. `DownloadConnectionPool` therefore opens extra gramjs clients on the SAME user session (same auth key, same process — ADR-007 still holds), `DOWNLOAD_CONNECTIONS` of them (default 4, max 8) in addition to the main one.
- **The main connection is reserved for uploads, deletes and metadata.** Big downloads run only on the pooled connections. Measured on one account: with downloads sharing the main connection, a concurrent upload fell from ~3 MB/s to ~0.4 MB/s (a plain CDN download at 2-5 MB/s in parallel did NOT slow it, so it is not the user's link); with downloads kept off the main connection the upload stayed at ~3 MB/s while downloads ran at ~1.3 MB/s.
- Pool rules: small downloads (< ~1 MiB) stay on the main connection and open nothing; each chunk of a big download goes to the least busy pooled connection; a dead pooled connection is evicted and its chunk retried; failure to open pooled connections never fails a download (the main connection is the fallback); they close after 60 s idle and when the user's lane is dropped (`adapter.close()`). The main client is never closed by the pool.
- `FILE_MIGRATE_n` switches the data center for the rest of the download; a `TIMEOUT` is retried once.

## 4. Reference Recovery (ADR-005)
On `FILE_REFERENCE_*` during a download the connector: refetches the message from the user's channel → extracts the new `file_reference` → updates `telegram_objects` → resumes the download from the byte it reached. One refresh per request.

## 5. Rate Limiting & FLOOD_WAIT
- gramjs sleeps automatically for waits ≤ 10 s (`floodSleepThreshold`). Longer waits surface as `FloodWaitError(seconds)`.
- The connector records the wait per user and rejects that user's calls until it passes; other users are unaffected.
- The worker reschedules a job no earlier than the FLOOD_WAIT (plus exponential backoff), max 5 attempts.
- Bounded concurrency per user: 3 uploads, 6 downloads.
