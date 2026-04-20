#!/bin/bash
set -euo pipefail
trap 'echo "install.sh failed at line $LINENO" >&2' ERR

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [[ ! -f "$ROOT_DIR/package.json" || ! -f "$ROOT_DIR/proxy.js" ]]; then
    echo "Run install.sh from an xmr-node-proxy checkout."
    exit 1
fi

if [[ "$(uname -s)" != "Linux" ]]; then
    echo "install.sh currently supports Linux hosts only."
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

install_with_apt() {
    export DEBIAN_FRONTEND=noninteractive
    $SUDO apt-get update
    $SUDO apt-get install -y --no-install-recommends g++ git libboost-date-time-dev libsodium-dev make nodejs npm openssl python3
}

install_with_dnf_family() {
    local package_manager=$1

    $SUDO "$package_manager" makecache

    if $SUDO "$package_manager" module list nodejs >/dev/null 2>&1; then
        $SUDO "$package_manager" module enable -y nodejs:20 || true
    fi

    $SUDO "$package_manager" install -y gcc-c++ git boost-devel libsodium-devel make nodejs npm openssl python3
}

if command -v apt-get >/dev/null 2>&1; then
    install_with_apt
elif command -v dnf >/dev/null 2>&1; then
    install_with_dnf_family dnf
elif command -v yum >/dev/null 2>&1; then
    install_with_dnf_family yum
else
    echo "Unsupported Linux package manager. install.sh supports apt, dnf, and yum hosts."
    exit 1
fi

for command_name in git node npm openssl python3 make g++; do
    if ! command -v "$command_name" >/dev/null 2>&1; then
        echo "Required command '$command_name' is not available after package install."
        exit 1
    fi
done

NODE_MAJOR=$(node -p 'Number(process.versions.node.split(".")[0])')
if [[ "$NODE_MAJOR" -lt 18 ]]; then
    echo "Node.js 18+ is required, but apt installed $(node -v)."
    exit 1
fi

cd "$ROOT_DIR"
npm install --no-audit --no-fund --no-package-lock

if [[ ! -f config.json ]]; then
    cp config_example.json config.json
fi

if [[ -f cert.key && -f cert.pem ]]; then
    :
elif [[ -f cert.key || -f cert.pem ]]; then
    echo "Found only one TLS file. Keep both cert.key and cert.pem, or remove both and rerun install.sh."
    exit 1
else
    openssl req -subj "/C=IT/ST=Pool/L=Daemon/O=Mining Pool/CN=mining.proxy" -newkey rsa:2048 -nodes -keyout cert.key -x509 -out cert.pem -days 36500
fi

npm test

echo "Install complete."
echo "Edit $ROOT_DIR/config.json and then run:"
echo "  node proxy.js --config $ROOT_DIR/config.json"
