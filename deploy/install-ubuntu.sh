#!/usr/bin/env bash
# Установка на чистый сервер Ubuntu 22.04/24.04 (Timeweb Cloud и др.). Запуск: sudo bash deploy/install-ubuntu.sh
set -e
APP_DIR=$(cd "$(dirname "$0")/.." && pwd)
IP=$(curl -s https://api.ipify.org || hostname -I | awk '{print $1}')
HOST="$(echo "$IP" | tr . -).sslip.io"

apt-get update
apt-get install -y curl debian-keyring debian-archive-keyring apt-transport-https gnupg
# Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
apt-get install -y nodejs
# Caddy (HTTPS автоматически)
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' > /etc/apt/sources.list.d/caddy-stable.list
apt-get update && apt-get install -y caddy

printf '%s {\n\treverse_proxy 127.0.0.1:3000\n}\n' "$HOST" > /etc/caddy/Caddyfile
systemctl restart caddy

if [ ! -f "$APP_DIR/.env" ]; then cp "$APP_DIR/.env.example" "$APP_DIR/.env"; fi
sed -i "s#^WEBAPP_URL=.*#WEBAPP_URL=https://$HOST#" "$APP_DIR/.env"

cat > /etc/systemd/system/sweetroses.service <<UNIT
[Unit]
Description=Sweet Roses mini app
After=network.target
[Service]
WorkingDirectory=$APP_DIR
ExecStart=/usr/bin/node server/index.js
Restart=always
Environment=NODE_ENV=production
[Install]
WantedBy=multi-user.target
UNIT
systemctl daemon-reload
systemctl enable --now sweetroses

echo
echo "Готово! Адрес мини-аппа: https://$HOST"
echo "Теперь впишите BOT_TOKEN и ADMIN_IDS в файл $APP_DIR/.env и выполните: systemctl restart sweetroses"
