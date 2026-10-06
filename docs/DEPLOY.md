# Deploy produksi ke VPS (Ubuntu 24.04)

Target: `https://drive.skalingga.my.id` (ganti sesuai subdomain pilihan).
Spesifikasi VPS: 2 vCPU, 2 GB RAM, 40 GB SSD.

## 1. DNS (di panel domain)
Buka **Manage DNS** domain `skalingga.my.id`, tambah record:

| Type | Name | Value |
|------|------|-------|
| A | drive | `IP_PUBLIK_VPS` |

Tunggu beberapa menit. Cek dari HP/PC: `ping drive.skalingga.my.id` harus menunjuk ke IP VPS.
Penting: DNS harus sudah benar SEBELUM langkah 5, kalau tidak HTTPS gagal terbit.

## 2. Login ke VPS
```
ssh root@IP_PUBLIK_VPS
```
Disarankan pakai SSH key, bukan password. Jangan bagikan password/key ke siapa pun (termasuk di chat).

## 3. Ambil kode
Repo private, jadi VPS butuh akses. Cara paling mudah: *deploy key* (read-only).
```
ssh-keygen -t ed25519 -f ~/.ssh/teledrive_deploy -N ""
cat ~/.ssh/teledrive_deploy.pub
```
Salin hasilnya ke GitHub: repo `tele-drive-v01` → Settings → Deploy keys → Add (jangan centang write).
```
cat >> ~/.ssh/config <<'CFG'
Host github.com
  IdentityFile ~/.ssh/teledrive_deploy
  IdentitiesOnly yes
CFG
git clone -b dev git@github.com:skalingga/tele-drive-v01.git /opt/teledrive
```

## 4. Setup server (sekali saja)
```
bash /opt/teledrive/deploy/setup-vps.sh
```
Memasang Docker, swap 2 GB, dan firewall (hanya port 22/80/443).

## 5. Konfigurasi
```
cd /opt/teledrive
cp .env.example .env
nano .env
```
Isi minimal:
- `NODE_ENV=production`
- `TELEGRAM_API_ID` dan `TELEGRAM_API_HASH` (dari https://my.telegram.org → API development tools)
- `TELEGRAM_SESSION_ENCRYPTION_KEY` (buat dengan: `openssl rand -hex 32`)
- `STORAGE_MODE=telegram`

**Backup `TELEGRAM_SESSION_ENCRYPTION_KEY` di tempat aman** (password manager). Jika hilang/berubah, semua user harus login ulang.

Lalu buat file domain untuk Compose:
```
echo "DOMAIN=drive.skalingga.my.id" > deploy/.env
```
(file `deploy/.env` sudah di-ignore git lewat pola `.env`.)

## 6. Jalankan
```
cd /opt/teledrive/deploy
docker compose -f docker-compose.prod.yml up -d --build
docker compose -f docker-compose.prod.yml logs -f
```
Build pertama memakan beberapa menit. Setelah log tenang, buka `https://drive.skalingga.my.id` dan login QR Telegram.

## 7. Operasional
- Update versi baru: `cd /opt/teledrive && git pull && cd deploy && docker compose -f docker-compose.prod.yml up -d --build`
- Lihat log: `docker compose -f docker-compose.prod.yml logs --tail 100 teledrive`
- Restart: `docker compose -f docker-compose.prod.yml restart teledrive`
- Backup data (SQLite + session): volume `teledrive_data`; contoh:
  `docker run --rm -v deploy_teledrive_data:/d -v $PWD:/b alpine tar czf /b/teledrive-data.tgz -C /d .`
- Hanya SATU instance TeleDrive yang boleh jalan. Matikan container di PC kalau memakai session yang sama.

## Masalah umum
- HTTPS tidak terbit: cek DNS record A, dan port 80/443 terbuka (`ufw status`).
- Build gagal kehabisan memori: pastikan swap aktif (`swapon --show`).
- Login QR gagal: cek `TELEGRAM_API_ID/HASH` dan log container.
