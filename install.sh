#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [[ ! -f "$ROOT_DIR/package.json" || ! -f "$ROOT_DIR/proxy.js" ]]; then
    echo "Run install.sh from an xmr-node-proxy checkout."
    exit 1
fi

if [[ $(id -u) -eq 0 ]]; then
    SUDO=
elif command -v sudo >/dev/null; then
    SUDO=sudo
else
    echo "sudo is required when running install.sh as a non-root user."
    exit 1
fi

export DEBIAN_FRONTEND=noninteractive
$SUDO apt-get update
$SUDO apt-get install -y --no-install-recommends g++ git libboost-date-time-dev libsodium-dev make nodejs npm openssl python3

cd "$ROOT_DIR"
npm install --no-audit --no-fund --no-package-lock
cp --update=none config_example.json config.json

if [[ ! -f cert.key || ! -f cert.pem ]]; then
    openssl req -subj "/C=IT/ST=Pool/L=Daemon/O=Mining Pool/CN=mining.proxy" -newkey rsa:2048 -nodes -keyout cert.key -x509 -out cert.pem -days 36500
fi

echo "Install complete."
echo "Edit $ROOT_DIR/config.json and then run:"
echo "  node proxy.js --config $ROOT_DIR/config.json"
