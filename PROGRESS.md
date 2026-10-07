# Progress

## Status terakhir
TeleDrive v1.3 berjalan: login QR Telegram, upload/download ke channel "TeleDrive Storage" milik user, dan UI drive berfungsi penuh. Dipakai sendiri selama ±1 minggu (mulai 2026-10-07) sebelum dibuka untuk orang lain.

## Sudah selesai
- [2026-10-07] Review menyeluruh + perbaikan: 1 akun Telegram per user, login QR saja (ADR-011), SQLite + job queue durable (ADR-012), session terenkripsi, keamanan API.
- [2026-10-07] Download paralel lewat pool koneksi (±1–2 MB/s); download besar tidak memakai koneksi utama agar upload tidak tersendat.
- [2026-10-07] Image Docker (`docker/Dockerfile`) ter-build dan berjalan; repo GitHub `skalingga/tele-drive-v01` (private).
- [2026-10-07] Perbaikan UI: menu ⋮ yang mati (Preview/Download/Rename/Move/Trash), klik kanan, keyboard, toast Urungkan, layout ponsel.
- [2026-10-07] Persiapan deploy VPS: `deploy/docker-compose.prod.yml` (TeleDrive + Caddy HTTPS), `deploy/setup-vps.sh`, `docs/DEPLOY.md`.
- [2026-10-07] CLAUDE.md + SYNC.md (aturan sinkronisasi PC ↔ cloud) dan PROGRESS.md.

## Sedang dikerjakan
- Deploy produksi ke VPS (Ubuntu 24.04, 2 vCPU/2 GB) di `drive.skalingga.my.id`: file siap (`deploy/`, `docs/DEPLOY.md`), menunggu user menjalankan di VPS.
- Opsi hemat biaya: laptop bekas (Windows → Ubuntu Server 24.04) + Cloudflare Tunnel; file siap (`deploy/docker-compose.tunnel.yml`, `docs/DEPLOY-LAPTOP.md`). Laptop belum dicek kelayakannya.

## Langkah berikutnya
0. User: ikuti `docs/DEPLOY.md` di VPS (DNS A record `drive` → IP VPS, deploy key, isi `.env`, `docker compose up`). Vercel tidak cocok (butuh proses long-running + SQLite).
1. Uji UI baru dengan file asli di container (`http://localhost:3000`).
2. Uji upload dari UI (antrean dua fase + progress).
3. Nanti: login dengan akun ber-2FA, lalu persiapan multi-user (HTTPS reverse proxy, CI).

## Catatan penting
- Container lokal dijalankan dengan `docker run` (bukan compose) agar memakai `data/` yang ada:
  `docker run -d --name teledrive --restart unless-stopped -p 127.0.0.1:3000:3000 -e NODE_ENV=production -e TELEGRAM_SESSION_STRING= -v "D:/DEV/tele-drive/.env:/app/.env:ro" -v "D:/DEV/tele-drive/data:/app/data" teledrive:test`
  `--env-file` tidak dipakai karena parser Docker membaca `.env` berbeda dari Node.
- Hanya SATU proses server boleh jalan (session MTProto tidak boleh dipakai dua proses): matikan container sebelum `npm run dev`.
- `TELEGRAM_SESSION_ENCRYPTION_KEY` wajib dibackup; jika berubah semua user harus login ulang.
- Upload ke Telegram baru ±45% dari kapasitas upload internet; belum diselidiki (ditunda).
- Belum ada tes otomatis untuk UI (tidak ada DOM test runner); bug menu ⋮ hanya diverifikasi manual di browser.
- Aturan teknis proyek: `AGENTS.md` dan `.agents/rules/*.md`.
