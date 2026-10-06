#!/usr/bin/env bash
# Setup awal VPS Ubuntu 24.04: Docker + firewall + swap. Jalankan sebagai root:
#   bash setup-vps.sh
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "Jalankan sebagai root (atau sudo)."; exit 1; fi

echo "==> Update paket"
apt-get update -y && apt-get upgrade -y
apt-get install -y ca-certificates curl git ufw

echo "==> Pasang Docker"
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sh
fi
systemctl enable --now docker

echo "==> Swap 2 GB (RAM VPS hanya 2 GB, mencegah build/OOM)"
if ! swapon --show | grep -q .; then
  fallocate -l 2G /swapfile && chmod 600 /swapfile
  mkswap /swapfile && swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
fi

echo "==> Firewall: hanya SSH, HTTP, HTTPS"
ufw default deny incoming
ufw default allow outgoing
ufw allow 22/tcp
ufw allow 80/tcp
ufw allow 443/tcp
ufw --force enable

echo "Selesai. Lanjut ke docs/DEPLOY.md langkah 4."
