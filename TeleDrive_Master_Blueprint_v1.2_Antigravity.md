# TeleDrive — Master Blueprint & Specification (v1.2 — Antigravity Edition)

> **Catatan v1.3 (2026-10-06):** beberapa keputusan di blueprint ini sudah diganti. Lihat `docs/adr/ADR-INDEX.md`:
> ADR-011 (1 akun Telegram per user, login hanya QR, menggantikan peer-per-user di 1 akun),
> ADR-012 (SQLite + job queue di database untuk MVP, menggantikan PostgreSQL/Redis/BullMQ untuk saat ini),
> ADR-007 amended (connector berjalan di satu proses server). Jika ada konflik, ADR dan `.agents/rules/` yang berlaku.

> **SINGLE SOURCE OF TRUTH — PRODUCT · ARCHITECTURE · SECURITY · AGENT PLAYBOOK**
> Private cloud file manager dengan Telegram MTProto sebagai storage backend, PostgreSQL sebagai source of truth metadata.
>
> v1.0 — baseline · v1.1 — decision log terintegrasi · **v1.2 — disesuaikan untuk Google Antigravity** (semula ditulis untuk OpenAI Codex)

---

## 0. Catatan Migrasi: Codex → Antigravity

Dokumen v1.1 asli ditulis dengan asumsi agent coding-nya adalah **Codex**, dengan satu file `AGENTS.md` di root sebagai satu-satunya sumber instruksi, dan alur kerja "Codex playbook" linear. Versi ini (v1.2) menyesuaikan bagian-bagian tersebut untuk **Google Antigravity**, tanpa mengubah keputusan arsitektur/produk di bagian A–K, E, F, H, I, J (itu semua tetap berlaku apa adanya).

Perubahan utama:

| Aspek | Codex (v1.1) | Antigravity (v1.2) |
|---|---|---|
| File instruksi utama | `AGENTS.md` tunggal di root | Antigravity **membaca `AGENTS.md` secara otomatis** (sejak IDE ≥1.20.5) — file root tetap dipertahankan untuk portabilitas, tapi detail per-area dipecah ke `.agents/rules/*.md` |
| Instruksi bertopik | Semua aturan dicampur di satu file | `.agents/rules/` — satu file per topik (arsitektur, security, testing, dsb), masing-masing dibatasi ~12.000 karakter |
| Urutan milestone manual | "Codex playbook" linear, dijalankan manual per prompt | `.agents/workflows/*.md` — macro command (mis. `/m03-telegram-poc`) yang mengorkestrasi tahapan otomatis |
| Pengetahuan yang dipelajari agent | Tidak terstruktur | `.antigravity/knowledge/*.md` — agent menyimpan pola/keputusan yang dipelajari agar konsisten di task berikutnya |
| Output kerja agent | Diff + ringkasan chat | **Artifacts**: Task List, Implementation Plan, Walkthrough — dibuat otomatis per task di Agent Manager, wajib direview manusia sebelum merge |
| Mode operasi | Satu sesi chat | **Agent Manager** (multi-task, bisa paralel/subagent) vs **Editor View** (kerja manual seperti VS Code) |
| Peran majemuk (PM → Engineer → QA) | Diprompt manual berurutan | Bisa dibungkus jadi satu Workflow (`.agents/workflows/startcycle.md`) yang mem-chain persona |

Struktur konten di bawah tetap mengikuti urutan asli (A–R), hanya bagian **G (Repository Blueprint)**, **L (dulu "Codex Playbook")**, dan **R (dulu "Master Handoff to Codex")** yang diubah signifikan.

---

## A. Product Blueprint

**A1 — Visi.** TeleDrive adalah private cloud file manager dengan UX seperti drive modern. Binary disimpan melalui Telegram/MTProto (akun user pribadi); PostgreSQL menjadi source of truth untuk metadata dan state.

**A2 — MVP vs Post-MVP**

| Wajib (MVP) | Post-MVP |
|---|---|
| Authentication / session | Public sharing |
| Nested folders | Team collaboration |
| Upload/download + queue (single-stream) | Chunked / resumable upload |
| Rename / move / delete / restore | Billing |
| Search / grid / list (paginated) | Native mobile |
| Favorites / recent / trash | AI OCR / search |
| Preview image/audio/PDF/basic video (direct render) | Video transcoding |
| Storage analytics (read-only) | Quota enforcement |
| — | Multi-provider replication |
| — | Advanced permissions |
| — | Server-side thumbnail generation |

**A3 — Prinsip**
- Storage abstraction — metadata di PostgreSQL; binary tidak disimpan permanen.
- Large transfer memakai streaming/worker (single-stream di MVP, chunked di Post-MVP).
- Security boundary ketat — isolasi per-user diperkuat lewat peer Telegram terpisah, bukan hanya row-level check.
- UI replaceable.
- Reliability dirancang sejak awal.
- Kuota adalah visibility feature di MVP, bukan enforcement feature.

---

## B. UI / UX Blueprint

| Option | Keputusan |
|---|---|
| 1 — Modern & Clean | DEFAULT; minimal, terang, fokus file |
| 2 — Dark Mode | SUPPORTED; theme tokens, komponen sama |
| 3 — Sidebar Expanded/Collapsed | SUPPORTED; wide navigation atau icon rail |

**AppShell Composition**: AppShell → Sidebar / Topbar (Search, Upload, Refresh, Account) → Breadcrumb → Toolbar → MainContent (FileGrid/FileList) → GlobalPlayer.

**Komponen inti**: FileCard/FolderCard · UploadZone/UploadQueue (progress/retry/cancel) · ContextMenu/Dialog/Dropdown · Preview image/video/audio/PDF (render langsung dari file asli, tanpa thumbnail server-side) · StorageWidget (info usage, bukan hard limit) · Empty/Error/Skeleton states · Responsive desktop/tablet/mobile · Keyboard focus + semantic controls · Touch target ~44px · Design tokens untuk theme/color/spacing · Destructive actions pakai confirmation.

---

## C. System Architecture & Stack

```
Browser
  │ HTTPS
  ▼
TanStack Start (Web + API)
  │
  ├── PostgreSQL (metadata)
  └── Redis / BullMQ (jobs)
  ▼
Storage Worker (multi-instance)
  ▼
StorageAdapter
  ▼
Telegram Connector (single-instance)
  ▼
Telegram MTProto
```

| Layer | Technology |
|---|---|
| Framework | TanStack Start + React + TypeScript |
| UI | Tailwind CSS + shadcn/ui + Lucide |
| Server state | TanStack Query |
| Validation | Zod |
| ORM | Drizzle |
| Database | PostgreSQL |
| Queue | Redis + BullMQ |
| Runtime | Node.js |
| Deploy | Docker + VPS + reverse proxy |

- UI hanya bicara ke API/service.
- Telegram hanya implementasi storage provider.
- Worker menangani transfer async, multi-instance — lihat D3 untuk strategi session.
- StorageAdapter membuka kemungkinan S3/R2/MinIO kelak.

---

## D. Telegram / MTProto

Telegram adalah storage provider, diakses lewat **akun user pribadi** (bukan Bot API) untuk mendukung file besar. Browser tidak pernah menerima API hash, session, atau credential.

```
TELEGRAM_API_ID=
TELEGRAM_API_HASH=
TELEGRAM_SESSION_ENCRYPTION_KEY=
TELEGRAM_STORAGE_PEER_ID=      // per-user, lihat D3
TELEGRAM_SESSION_VERSION=
```

**D1 — Adapter contract**
```ts
interface StorageAdapter {
  upload(input: UploadInput): Promise<StorageObject>;
  download(object: StorageObject, options?: DownloadOptions): AsyncIterable<Buffer>;
  delete(object: StorageObject): Promise<void>;
  refreshReference(object: StorageObject): Promise<StorageObject>;
  exists(object: StorageObject): Promise<boolean>;
}
```

**D2 — Reference recovery flow**
upload → save message/object metadata → download → validate `file_reference` → valid: stream · expired: refetch source → update DB → retry.

**D3 — Session & peer strategy**

Karena worker dijalankan multi-instance dan setiap user punya peer/channel Telegram terpisah, akses MTProto tidak boleh dibuka concurrent dari >1 proses.

```
Worker #1   Worker #2   Worker #N
      │  job queue (routed, tidak fan-out langsung)
      ▼
Telegram Connector (single-instance, restart-safe)
      ▼
Telegram (1 akun storage, peer per user)
```

**Rekomendasi:** opsi (b) — dedicated connector process — lebih aman daripada distributed lock (opsi a), karena menghindari race condition pada `request_id`/session state MTProto. Worker BullMQ tetap multi-instance untuk orkestrasi job; hanya satu connector yang bicara langsung ke Telegram. Provisioning peer per user terjadi saat registrasi atau upload pertama.

- Bounded concurrency · Retry transient errors dengan backoff
- Respect `FLOOD_WAIT` · Reconnect MTProto dengan backoff
- Jangan log secrets / session / file contents

Telegram POC sebelum UI kompleks: login user account → connect → provision peer test → upload → metadata → download → reconnect → reference refresh → rate-limit/error handling. Validasi ToS Telegram dicatat sebagai risiko berjalan (bagian P), tidak memblokir mulainya POC.

---

## E. Database

| Table | Core fields | Fungsi |
|---|---|---|
| users | id, email, password_hash, plan, status, telegram_peer_id | Identity + peer assignment |
| sessions | id, user_id, token_hash, expires_at | Auth |
| folders | id, user_id, parent_id, name, deleted_at | Tree |
| files | id, user_id, folder_id, name, mime_type, size_bytes, checksum, status | Metadata |
| telegram_objects | file_id, peer_id, message_id, document_id, access_hash, file_reference, dc_id | Telegram mapping (peer_id per user) |
| upload_jobs | id, file_id, status, progress_bytes, attempts, error_code | Upload |
| download_jobs | id, file_id, status, progress_bytes, attempts, error_code | Download |
| favorites | user_id, file_id, created_at | Favorite |
| activity_logs | user_id, action, entity_type, entity_id, metadata, created_at | Audit |

**Entity relations**: users 1—N folders · users 1—N files · users 1—1 telegram_peer_id · folders 1—N files · files 1—1 telegram_objects · files 1—N upload_jobs/download_jobs · users N—N files (via favorites).

- Ownership harus konsisten — **diperkuat ganda**: row-level (user_id) dan peer-level (peer_id ≠ peer user lain).
- Index user/folder/name/created_at; telegram_objects(file_id); jobs(status).
- Soft delete via deleted_at. Permanent deletion explicit dan idempotent.
- Tidak ada tabel quota-enforcement di MVP; `storage_analytics` view cukup untuk display usage.

**File state machine**: pending → uploading → ready (atau failed/cancelled) · ready → deleting → deleted.

---

## F. API Specification

```json
// Success
{ "data": ..., "error": null, "meta": ... }
// Error
{ "data": null, "error": { "code": "...", "message": "...", "details": ... }, "meta": {} }
```

| Method | Endpoint | Purpose |
|---|---|---|
| POST | /api/auth/register | Register |
| POST | /api/auth/login | Login |
| POST | /api/auth/logout | Logout |
| GET | /api/me | Current user |
| GET | /api/files | List/filter paginated |
| POST | /api/files/upload | Create upload |
| GET | /api/files/:id | Metadata |
| PATCH | /api/files/:id | Rename/update |
| DELETE | /api/files/:id | Trash/delete |
| GET | /api/files/:id/content | Stream |
| POST | /api/files/:id/restore | Restore |
| POST/DELETE | /api/files/:id/favorite | Favorite |
| GET/POST | /api/folders | List/create |
| PATCH/DELETE | /api/folders/:id | Rename/move/delete |
| GET | /api/search?q= | Search paginated |
| GET | /api/uploads/:id | Job status |
| POST | /api/uploads/:id/cancel | Cancel |
| GET | /api/storage | Usage/status (display only) |

**F1 — Pagination wajib sejak M07**
```
GET /api/files?cursor=<opaque>&limit=<n>&folder_id=...
GET /api/search?q=...&cursor=<opaque>&limit=<n>
```
Cursor opaque (encode last id/created_at), bukan offset. `meta.next_cursor` wajib (null bila habis). Default limit 50, maksimum 200. Authorization: setiap resource lookup harus di-scope current authenticated user — jangan percaya user_id dari request.

| Code | Meaning |
|---|---|
| AUTH_REQUIRED | No valid session |
| FORBIDDEN | Not owner/permission |
| NOT_FOUND | Unavailable |
| VALIDATION_ERROR | Invalid input |
| UPLOAD_FAILED | Transfer failure |
| STORAGE_REFERENCE_EXPIRED | Refresh needed |
| STORAGE_RATE_LIMITED | Provider delay |
| CONFLICT | State/name conflict |
| INTERNAL_ERROR | Unexpected error |

---

## G. Repository Blueprint (disesuaikan untuk Antigravity)

```
teledrive/
├── apps/web/
│   ├── routes/
│   ├── components/
│   ├── features/
│   └── styles/
├── packages/
│   ├── database/                # schema, migrations, repositories
│   ├── shared/                  # types, validation, errors
│   ├── storage/                 # adapter, types
│   ├── telegram/                # MTProto adapter + connector process
│   └── ui/
├── workers/storage-worker/          # multi-instance orchestration
├── workers/telegram-connector/      # single-instance, talks to MTProto (D3)
├── docs/
├── tests/
├── docker/
├── AGENTS.md                    # dibaca otomatis oleh Antigravity — ringkas, tautkan ke .agents/rules/
├── .agents/
│   ├── rules/                   # aturan per-topik, tiap file ≤ ~12.000 karakter
│   │   ├── architecture.md      # boundary UI→API→Service→StorageAdapter→connector
│   │   ├── security.md          # ownership row+peer, no-credential-leak, rate limit
│   │   ├── telegram-mtproto.md  # D1-D3: adapter contract, session/connector rule
│   │   ├── database.md          # skema, index, soft delete, migrations
│   │   ├── api-conventions.md   # response envelope, pagination, error codes (F)
│   │   └── testing.md           # gate per level (J), release gate
│   ├── workflows/                # macro command, dipanggil via "/nama-workflow" di chat
│   │   ├── m03-telegram-poc.md
│   │   ├── m04-connector-adapter.md
│   │   ├── m05-worker-queue.md
│   │   ├── m07-file-api.md
│   │   ├── m13-security-audit.md
│   │   └── startcycle.md        # orkestrasi PM→Engineer→QA untuk milestone baru
│   └── skills/                   # skill reusable (mis. write_adr.md, write_specs.md)
├── .antigravity/
│   └── knowledge/                # agent menulis pola yang dipelajari — jangan diedit manual
│       ├── mtproto-patterns.md
│       ├── api_conventions.md
│       └── testing_standards.md
├── package.json
```

**Dependency direction** (tidak berubah dari v1.1):
- web → shared + application APIs
- worker → storage + database
- telegram-connector → storage interfaces/types (single-instance only)
- ui → reusable components
- storage → no UI dependency

**Catatan setup Antigravity:**
- Root `AGENTS.md` tetap ada (portabilitas ke tool lain: Codex, Cursor, Claude Code) tapi isinya diringkas jadi index/pointer ke `.agents/rules/*.md` — supaya tidak mengulang isi yang sudah ada di rules bertopik.
- Jika suatu saat ingin memakai Gemini CLI juga, cukup set `context.fileName` ke `AGENTS.md` di settings, atau simpan salinan sebagai `GEMINI.md` — tidak perlu duplikasi manual berkelanjutan.
- Rules file dibatasi ~12.000 karakter oleh Antigravity — jaga tiap file di `.agents/rules/` tetap fokus satu topik supaya tidak terpotong.
- `.antigravity/knowledge/` diisi oleh agent sendiri (bukan ditulis manusia) — dipakai untuk konsistensi lintas task, mis. mencatat "Decided in [milestone/PR]" untuk keputusan implementasi kecil yang tidak butuh ADR formal.

---

## H. Security Blueprint

| Threat | Control |
|---|---|
| IDOR | Object-level ownership checks + peer-level isolation (peer per user) |
| Session theft | Secure cookie / session expiry |
| Secret leakage | Server-only secrets + encrypted Telegram session |
| Malicious filename | Normalize/sanitize; no traversal |
| Oversized upload | Size limit realistis untuk single-stream MVP |
| Queue abuse | Rate limit + bounded concurrency |
| Telegram limits | Respect FLOOD_WAIT / backoff |
| Log leakage | Redact secrets/file contents |
| DoS | Request/job resource bounds |
| SSRF | No arbitrary URL fetch in preview |
| MTProto session race | Single connector process / distributed lock (D3) |

**Trade-off eksplisit** yang perlu dikomunikasikan ke user produk: file tidak dienkripsi tambahan sebelum diupload ke Telegram (di luar session key encryption). Keamanan bergantung pada isolasi peer per-user + keamanan Telegram sendiri.

HTTPS production · Modern password hashing · Zod boundary validation.

**Security tests**: audit login/upload/download/rename/move/delete/restore · database backup+restore test · secret rotation/revocation.

---

## I. Jobs & Reliability

```
Browser → create job → Redis/BullMQ → Worker (multi-instance)
  → telegram-connector (single-instance) → Telegram
  → save object → file ready → progress/status
```

**Job state machine**: queued → processing → completed (atau failed/cancelled) · failed → retrying → processing.

- Retry transient errors only · Exponential backoff + max attempts
- Cancel idempotent · Persist state for safe worker restart
- Progress periodik · Large download streaming, bukan full RAM buffer
- Upload MVP: single-stream — kegagalan di tengah upload berarti retry dari awal (batasan MVP, dicatat sadar)
- Handle disconnect, expired reference, FLOOD_WAIT, crash, partial upload, duplicate delivery
- Job routing ke telegram-connector harus antri (bukan fan-out langsung) agar tidak menabrak batas satu-session MTProto

---

## J. Testing & QA

| Level | Minimum |
|---|---|
| Unit | Validation, checksum, state machine, auth helpers |
| Integration | Repositories, StorageAdapter, worker, connector routing |
| API | Auth, CRUD, ownership, search+pagination, jobs |
| E2E | Register → folder → upload → preview → download → delete → restore |
| Failure | Disconnect, reference refresh, retry, restart, FLOOD_WAIT, connector failover |
| Security | Cross-user IDs, cross-peer access attempt, malformed input, rate limits, secret audit |

**Release gate**: User A tidak bisa membaca User B (row dan peer level); transfer survive transient failure; large file tidak buffer penuh; reference dapat refresh; worker restart aman; pagination konsisten saat data berubah; UI tetap usable; tidak ada P0 security finding.

> Di Antigravity, setiap task Agent Manager wajib menghasilkan **Artifact Walkthrough** yang mencantumkan hasil test level di atas sebelum manusia menyetujui merge — lihat bagian L.

---

## K. Deployment & Operations

```
Reverse Proxy / HTTPS
  ├── Web App
  ├── Storage Worker(s) (multi-instance)
  └── Telegram Connector (single-instance)
        ▼
   PostgreSQL · Redis
```

- Docker / reproducible environment · Persistent PostgreSQL volume
- Health/readiness endpoints (termasuk health connector — kalau connector down, semua transfer terhenti)
- Structured logs · Queue/worker metrics
- Scheduled DB backup + restore drill
- Development/staging/production secrets terpisah

> Sebelum go-live: review ulang Telegram ToS untuk use-case bulk storage pihak ketiga (risiko dari bagian P) — jadi checklist wajib di sini meski bukan gate di POC.

| Metric | Purpose |
|---|---|
| queue_depth | Backlog |
| job_failure_rate | Reliability |
| transfer_throughput | Capacity |
| worker_restarts | Stability |
| connector_uptime | Single point of failure MTProto |
| rate_limit_events | Concurrency tuning |
| API_error_rate | App health |
| DB_latency / connections | DB health |

---

## L. Antigravity Playbook & Roadmap *(dulu: "Codex Playbook")*

### L1 — Root `AGENTS.md` (ringkas, index ke rules bertopik)

```md
# TeleDrive Engineering Rules — Index

Detail lengkap ada di .agents/rules/*.md — baca semua sebelum coding.

1. Preserve UI/service/storage boundaries (lihat .agents/rules/architecture.md).
2. Never expose Telegram credentials.
3. Never store binary files in PostgreSQL.
4. All storage operations use StorageAdapter.
5. Large transfers use streaming/workers.
6. Every user resource requires authorization (row + peer level) — .agents/rules/security.md.
7. Respect Telegram rate limits/FLOOD_WAIT — .agents/rules/telegram-mtproto.md.
8. File references must support refresh.
9. TypeScript strict + Zod validation.
10. Tests required for business logic — .agents/rules/testing.md.
11. No unrelated refactor.
12. MTProto session access only via the single telegram-connector.
13. API list/search endpoints must be cursor-paginated — .agents/rules/api-conventions.md.
```

### L2 — `.agents/rules/` (contoh isi salah satu file)

`.agents/rules/telegram-mtproto.md`:
```md
# Telegram / MTProto Rules

- StorageAdapter contract wajib diimplementasikan lengkap (upload/download/delete/refreshReference/exists).
- MTProto HANYA boleh diakses dari workers/telegram-connector — worker BullMQ lain dilarang connect langsung.
- Job routing ke connector harus lewat antrean, bukan fan-out langsung (hindari race pada session state).
- Selalu tangani file_reference expired dengan refetch → update DB → retry.
- Respect FLOOD_WAIT dengan backoff; reconnect otomatis.
- Dilarang log secrets/session/file contents.
- Reference: keputusan ini = ADR-007 dan ADR-008.
```

### L3 — `.agents/workflows/` — macro command per milestone

Alih-alih menjalankan playbook Codex secara manual berurutan, tiap milestone besar dibungkus jadi workflow yang bisa dipanggil dengan `/nama-workflow` di Agent Manager. Contoh `.agents/workflows/m03-telegram-poc.md`:

```md
---
description: Jalankan POC Telegram MTProto (M03) sesuai bagian D dari master spec
---
Baca AGENTS.md dan .agents/rules/telegram-mtproto.md sebelum mulai.

Urutan:
1. Implement login-flow user account (bukan Bot API).
2. Connect + provision peer test.
3. Upload file test → simpan metadata.
4. Download file test → validasi file_reference.
5. Simulasikan disconnect → reconnect dengan backoff.
6. Simulasikan file_reference expired → refresh flow.
7. Simulasikan FLOOD_WAIT → verifikasi backoff.

Akhiri dengan: ringkasan hasil test, risiko yang ditemukan, dan Artifact Walkthrough.
Jangan lanjut ke M04 sebelum manusia approve walkthrough ini.
```

Workflow serupa dibuat untuk M04 (connector/adapter), M05 (worker/queue), M07 (file API + pagination), M13 (security audit cross-peer), dst — satu file per milestone di L4 di bawah.

Opsional: `.agents/workflows/startcycle.md` bisa mem-bungkus persona PM → Engineer → QA berurutan untuk milestone baru yang belum punya workflow spesifik (persona ditulis di `.agents/skills/`, dipanggil workflow ini).

### L4 — Roadmap M00–M15 (tidak berubah dari v1.1, tiap baris = kandidat 1 workflow)

| Milestone | Fokus | Acceptance gate |
|---|---|---|
| M00 | Repo / tooling | Build/lint/typecheck |
| M01 | DB + migrations | Schema tests |
| M02 | Auth | Session/ownership tests |
| M03 | Telegram POC (user account login) | Connect/upload/download/peer provisioning |
| M04 | StorageAdapter + telegram-connector | Single-instance connector verified |
| M05 | Redis/BullMQ worker (multi-instance) | Retry/progress/restart, routing verified |
| M06 | Download streaming | Memory/stream tests |
| M07 | File/folder API | CRUD/search/trash/favorite/pagination |
| M08 | UI foundation | Shell/grid/list |
| M09 | Upload UX | Queue/progress/cancel (single-stream) |
| M10 | Preview | Direct render, no thumbnail job |
| M11 | UI variants | Dark / sidebar |
| M12 | Reliability | Reference refresh / connector failover |
| M13 | Security | Cross-peer isolation test |
| M14 | E2E | Critical journeys |
| M15 | Production | Docker/HTTPS/backup + ToS review |

### L5 — Output kerja: Artifacts (pengganti "diff + ringkasan chat")

Setiap task di Agent Manager Antigravity menghasilkan tiga artifact yang **wajib direview manusia** sebelum lanjut:
1. **Task List** — breakdown langkah untuk milestone yang sedang dikerjakan.
2. **Implementation Plan** — pendekatan teknis sebelum kode ditulis (harus konsisten dengan bagian C/D/E/F di spec ini).
3. **Walkthrough** — hasil akhir: apa yang berubah, test yang dijalankan (lihat J), risiko yang tersisa.

Alur kerja: `inspect → plan (Implementation Plan) → implement → test → typecheck → lint → Walkthrough → review manusia → docs update → next milestone`.

---

## M. Architecture Governance / ADR

| ADR | Decision |
|---|---|
| 001 | Telegram storage via StorageAdapter |
| 002 | PostgreSQL metadata-only |
| 003 | Large transfers via queue/worker |
| 004 | UI variants via shared components/tokens |
| 005 | Reference recovery is core reliability |
| 006 | Authorization at API/service boundary |
| 007 | MTProto via user account, single telegram-connector process |
| 008 | Peer-per-user isolation model |
| 009 | No file-level encryption beyond session key in MVP |
| 010 | No chunked upload / quota enforcement in MVP |

Buat ADR baru bila mengganti storage/database/auth/ownership/job model atau security boundary. Jangan menembus boundary hanya demi satu feature. ADR baru ditulis manual oleh manusia (atau via `.agents/skills/write_adr.md` bila didelegasikan ke agent), disimpan di `docs/adr/`, dan dirujuk dari `.agents/rules/` terkait.

```md
# ADR-XXX: <title>
Status: Proposed | Accepted | Superseded
Context:
Decision:
Alternatives:
Consequences:
Security impact:
Migration plan:
Date:
```

---

## N. Development Workflow & Pre-Coding Checklist

```
Specification → Acceptance criteria → ADR (if needed)
  → Antigravity workflow/task → Implementation → Automated tests
  → Manual verification (Walkthrough review) → Diff/code review → Update docs → Next milestone
```

- Satu milestone satu tujuan · Commit kecil dan bermakna
- Behavior baru wajib punya test · Dokumentasi mengikuti implementasi
- Jangan gabungkan feature dengan refactor besar

### O. Pre-Coding Checklist

- [ ] Master specification tersimpan (dokumen ini).
- [ ] `AGENTS.md` ada di root, isinya index ke `.agents/rules/`.
- [ ] `.agents/rules/`, `.agents/workflows/`, `.agents/skills/` sudah discaffold.
- [ ] Repo structure siap (termasuk `workers/telegram-connector/`).
- [ ] PostgreSQL + Redis development siap.
- [ ] Telegram credentials aman (akun user pribadi, bukan bot).
- [ ] Strategi session/connector (D3) sudah dipilih dan ditulis sebagai ADR-007.
- [ ] Telegram POC (workflow M03) dilakukan sebelum UI kompleks.
- [ ] Typecheck/lint/unit/integration/E2E runner siap.
- [ ] Backup/restore plan ditentukan.
- [ ] M00 acceptance gate jelas.

---

## P. Open Decisions / Risks

| Item | Status | Rekomendasi |
|---|---|---|
| Telegram policies/limits | Risiko berjalan | Validate current official docs/Terms sebelum production (checklist M15) |
| MTProto library | Terbuka | Choose after POC based on stability/API needs |
| Large-file limits (single-stream) | Terbuka | Benchmark before promising limits |
| Range streaming | Terbuka | Basic streaming first; optimize after measurement |
| Session/connector concurrency | Diputuskan | Tetap perlu ADR formal (ADR-007) sebelum M04 |
| Peer-per-user provisioning cost | Terbuka | Ukur waktu create channel saat registrasi; pertimbangkan lazy provisioning |
| Chunked upload | Post-MVP | Rencanakan desain awal agar migrasi tidak menabrak schema upload_jobs |
| Quota enforcement | Post-MVP | Analytics-only dulu; siapkan kolom agar tidak perlu migrasi besar nanti |
| S3/R2 fallback | Terbuka | Keep adapter boundary; implement only if needed |

---

## Q. Final Product Contract

TeleDrive v1.2 =
Private Cloud UX + TanStack Start + PostgreSQL Metadata
+ Telegram MTProto Storage (user account, peer-per-user)
+ Single Telegram Connector (session safety) + StorageAdapter
+ Redis/BullMQ Jobs (multi-instance)
+ Secure Auth & Authorization (row + peer level)
+ Modern Clean UI + Dark Mode + Expanded/Collapsed Sidebar
+ Search/Folders/Favorites/Trash/Recent (paginated)
+ Preview (direct render) + Reference Recovery
+ Testing/Observability + Production Deployment
+ **Dikelola lewat Antigravity Agent Manager: Rules → Workflows → Artifacts**

**Golden rule**: validasikan Telegram POC terlebih dahulu, termasuk strategi session/connector (D3). Urutan: POC → Connector/Adapter → DB → Queue → API (paginated) → UI → Reliability → Security → E2E → Production.

---

## R. Master Handoff to Antigravity *(dulu: "Master Handoff to Codex")*

Gunakan teks ini sebagai prompt awal saat membuka workspace TeleDrive di **Agent Manager** (bukan lagi format "system prompt" satu arah seperti Codex — di Antigravity ini jadi task pertama yang menghasilkan Task List + Implementation Plan untuk direview sebelum eksekusi):

```
You are implementing TeleDrive, a private cloud file manager
using Telegram MTProto (user account) as storage, inside Google Antigravity.

The TeleDrive Master Specification v1.2 (this document) is the source of truth.
Read AGENTS.md and every file in .agents/rules/ before coding.
Check .antigravity/knowledge/ for patterns already learned from prior tasks.

Mandatory architecture:
Browser/UI → Application API → Services → StorageAdapter
  → telegram-connector (single-instance) → Telegram
       ↓
  PostgreSQL + Redis/Worker (multi-instance)

Never expose Telegram credentials.
Never store binary files in PostgreSQL.
Never bypass ownership authorization (row + peer level).
Never bypass Telegram rate limits.
Never call MTProto directly from a multi-instance worker —
  always route through telegram-connector.
Never return unpaginated list/search results.

Implement only the requested milestone (use the matching .agents/workflows/ file if one exists).
Produce a Task List and Implementation Plan artifact and pause for approval before writing code.
Finish with: tests, typecheck, lint, diff summary, risks, and a Walkthrough artifact.
```

---

*END — TeleDrive Master Blueprint & Specification v1.2 (Antigravity Edition)*
