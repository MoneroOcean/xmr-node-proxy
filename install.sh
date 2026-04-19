#!/bin/bash
set -euo pipefail

echo "This assumes that you are doing a green-field install.  If you're not, please exit in the next 15 seconds."
sleep 15
echo "Continuing install, this will prompt you for your password if you're not already running as root and you didn't enable passwordless sudo.  Please do not run me as root!"
if [[ $(whoami) == "root" ]]; then
    echo "You ran me as root! Do not run me as root!"
    exit 1
fi
CURUSER=$(whoami)

if command -v dnf >/dev/null; then
  sudo dnf -y upgrade
  sudo dnf -y install ca-certificates git curl make gcc-c++ nodejs npm openssl pkgconf-pkg-config python3 boost-devel boost-system-devel boost-date-time-devel libsodium-devel
elif command -v yum >/dev/null; then
  sudo yum -y update
  sudo yum -y upgrade
  sudo yum -y install ca-certificates git curl make gcc-c++ nodejs npm openssl pkgconfig python3 boost-devel boost-system-devel boost-date-time-devel libsodium-devel
else
  sudo apt-get update
  sudo DEBIAN_FRONTEND=noninteractive apt-get -y upgrade
  sudo DEBIAN_FRONTEND=noninteractive apt-get -y install ca-certificates git curl make g++ nodejs npm openssl pkg-config python3 libboost-dev libboost-system-dev libboost-date-time-dev libsodium-dev
fi
cd ~
git clone https://github.com/MoneroOcean/xmr-node-proxy
cd ~/xmr-node-proxy
npm install || exit 1
npm install -g pm2
cp --update=none config_example.json config.json
openssl req -subj "/C=IT/ST=Pool/L=Daemon/O=Mining Pool/CN=mining.proxy" -newkey rsa:2048 -nodes -keyout cert.key -x509 -out cert.pem -days 36500
cd ~
pm2 status || true
sudo env PATH="$PATH" "$(command -v pm2)" startup systemd -u "$CURUSER" --hp "$HOME"
sudo chown -R $CURUSER. ~/.pm2
echo "Installing pm2-logrotate in the background!"
pm2 install pm2-logrotate
echo "You're setup with a shiny new proxy! Go configure it and have fun."
