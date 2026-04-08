#!/bin/sh
set -e
cd /app

export PORT="${PORT:-3000}"

# --- Root phase: ensure /app is writable by the non-root user ---
if [ "$(id -u)" = "0" ]; then
  echo "[srx] chown /app → node…"
  chown -R node:node /app
  chown -R node:node /home/node 2>/dev/null || true
  exec setpriv --reuid=node --regid=node --clear-groups -- "$0" "$@"
fi

# --- Non-root phase (running as `node`) ---
export HOME=/home/node
export npm_config_cache="${npm_config_cache:-$HOME/.npm}"
mkdir -p "$HOME" "$npm_config_cache" 2>/dev/null || true

# Verify critical native deps survived the chown / layer copy.
if ! node -e "require('lightningcss')" 2>/dev/null; then
  echo "[srx] lightningcss native binding missing — running npm ci…"
  npm ci
fi
if ! node -e "require('lightningcss')" 2>/dev/null; then
  echo "[srx] FATAL: lightningcss still fails after npm ci." >&2
  exit 1
fi

echo "[srx] prisma generate + db push…"
npx prisma generate
npx prisma db push

echo "[srx] starting Next.js production server on 0.0.0.0:${PORT} (user: $(whoami))…"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
exec npx next start --hostname 0.0.0.0 --port "${PORT}"
