# Deploy di laptop bekas (Ubuntu Server + Cloudflare Tunnel)

Alternatif hemat dari VPS: laptop di rumah, diakses dari luar lewat Cloudflare Tunnel (gratis).
Panduan VPS tetap ada di `DEPLOY.md` sebagai cadangan.

## A. Cek kelayakan laptop
- RAM ≥ 4 GB (2 GB masih mungkin), CPU 64-bit, disk kosong ≥ 15 GB.
- Pakai kabel LAN jika bisa (Wi-Fi lebih mudah putus).

## B. Rencana install Ubuntu Server 24.04 (menghapus Windows)
**Peringatan:** langkah ini menghapus isi disk laptop. Backup dulu semua data penting.

1. **Siapkan USB** (≥ 8 GB, isinya akan terhapus) dari PC lain:
   - Unduh "Ubuntu Server 24.04 LTS" dari ubuntu.com.
   - Tulis ke USB dengan Rufus (pilih GPT + UEFI, mode ISO) atau balenaEtcher.
2. **Boot dari USB:** colok USB, nyalakan laptop, tekan tombol boot menu (umumnya F12, F9, Esc, atau F2; beda per merek). Jika USB tak muncul, matikan Secure Boot di BIOS.
3. **Installer:**
   - Bahasa English, keyboard sesuai.
   - Network: biarkan DHCP (kabel LAN lebih baik).
   - Storage: "Use an entire disk" (LVM boleh dimatikan agar sederhana).
   - Profile: nama server `teledrive`, buat user biasa dan password kuat.
   - **Centang "Install OpenSSH server"** supaya bisa dikelola dari PC/HP.
   - Jangan pilih snap tambahan.
4. **Selesai & reboot**, cabut USB. Lihat IP laptop: `ip a`.
5. **Dari PC:** `ssh USER@IP_LAPTOP`.
6. **Pengaturan laptop agar jalan terus:**
   ```
   sudo nano /etc/systemd/logind.conf
   ```
   Set `HandleLidSwitch=ignore`, `HandleLidSwitchExternalPower=ignore`, lalu `sudo systemctl restart systemd-logind`.
   Opsional: `sudo apt install -y tlp` untuk hemat daya.
7. **Update + Docker + firewall:**
   ```
   sudo apt update && sudo apt -y upgrade
   curl -fsSL https://get.docker.com | sudo sh
   sudo usermod -aG docker $USER   # logout/login ulang
   sudo apt install -y git ufw unattended-upgrades
   sudo ufw default deny incoming && sudo ufw allow 22/tcp && sudo ufw --force enable
   ```
   Port 80/443 TIDAK perlu dibuka: Cloudflare Tunnel hanya membuat koneksi keluar.
8. **Di router (opsional):** beri laptop IP tetap (DHCP reservation) agar SSH selalu ke alamat sama.

Jika belum siap menghapus Windows, uji dulu lewat Docker Desktop (Windows), memakai perintah compose yang sama di PowerShell. Ini lebih boros RAM, jadi hanya untuk uji coba.

## C. Ambil kode dan konfigurasi
```
ssh-keygen -t ed25519 -f ~/.ssh/teledrive_deploy -N ""
cat ~/.ssh/teledrive_deploy.pub     # tambahkan sebagai Deploy key (read-only) di repo GitHub
printf 'Host github.com\n  IdentityFile ~/.ssh/teledrive_deploy\n  IdentitiesOnly yes\n' >> ~/.ssh/config
git clone -b dev git@github.com:skalingga/tele-drive-v01.git ~/teledrive
cd ~/teledrive && cp .env.example .env && nano .env
```
Isi `.env`: `NODE_ENV=production`, `TELEGRAM_API_ID`, `TELEGRAM_API_HASH`, `TELEGRAM_SESSION_ENCRYPTION_KEY` (`openssl rand -hex 32`, **backup key ini**), `STORAGE_MODE=telegram`.

## D. Cloudflare Tunnel

### Mode cepat (tanpa domain, untuk uji coba)
```
cd ~/teledrive/deploy
docker compose -f docker-compose.tunnel.yml --profile quick up -d --build teledrive cloudflared-quick
docker logs teledrive-tunnel-quick 2>&1 | grep trycloudflare
```
Buka alamat `https://xxxx.trycloudflare.com` yang muncul. Alamat berubah tiap container dibuat ulang.

### Mode tetap (`drive.skalingga.my.id`)
1. Buat akun Cloudflare (gratis), tambahkan domain `skalingga.my.id`, lalu ganti nameserver di panel domain (Domain Settings) ke nameserver yang diberikan Cloudflare. Tunggu aktif.
2. Cloudflare dashboard → Zero Trust → Networks → Tunnels → Create tunnel (cloudflared). Salin **token**.
3. Di tunnel itu, tambah Public hostname: `drive.skalingga.my.id` → Service `HTTP` → `teledrive:3000`.
4. Di laptop:
   ```
   cd ~/teledrive/deploy
   echo "TUNNEL_TOKEN=ISI_TOKEN" > .env      # file ini di-ignore git
   docker compose -f docker-compose.tunnel.yml up -d --build teledrive cloudflared
   ```
5. Buka `https://drive.skalingga.my.id`, login QR Telegram.

Token tunnel = rahasia; jangan dibagikan atau di-commit.

## E. Operasional
- Update: `cd ~/teledrive && git pull && cd deploy && docker compose -f docker-compose.tunnel.yml up -d --build teledrive`
- Log: `docker logs --tail 100 teledrive`
- Container otomatis hidup lagi setelah reboot (`restart: unless-stopped`).
- Hanya SATU instance TeleDrive: matikan container di PC dan di VPS sebelum menjalankan ini.
- Jika VPS tidak dipakai lagi, hentikan langganannya agar tidak ada biaya bulanan.
