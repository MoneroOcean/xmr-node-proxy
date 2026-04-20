#!/bin/bash
set -euo pipefail

ROOT_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)

if [[ ! -f "$ROOT_DIR/package.json" || ! -f "$ROOT_DIR/proxy.js" ]]; then
    echo "Run update.sh from an xmr-node-proxy checkout."
    exit 1
fi

cd "$ROOT_DIR"

if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "update.sh expects a git checkout."
    exit 1
fi

OLD_REV=$(git rev-parse --short HEAD)

echo "Resetting local checkout to origin/master and removing untracked files."
git fetch --prune origin
git reset --hard origin/master
git clean -fd
rm -f package-lock.json

npm install --no-audit --no-fund --no-package-lock
npm test

NEW_REV=$(git rev-parse --short HEAD)

if [[ "$OLD_REV" == "$NEW_REV" ]]; then
    echo "Proxy is already up to date at $NEW_REV."
else
    echo "Proxy updated from $OLD_REV to $NEW_REV."
fi

echo "Update verification passed."
if command -v pm2 >/dev/null 2>&1; then
    echo "Restart the running proxy with the correct PM2 process name, for example:"
    echo "  pm2 restart xnp"
    echo "Use 'pm2 list' if your process name is different."
else
    echo "Restart the running proxy with your usual service manager or shell command."
fi
