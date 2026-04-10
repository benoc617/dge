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

# Retry db push until MySQL is ready.
# MySQL passes its healthcheck probe (mysqladmin ping) slightly before it is
# fully open to client connections after a cold-start or host reboot.
# set -e is in effect, but POSIX sh does not exit on a non-zero exit from a
# command that is the condition of an if/while/until, so this loop is safe.
_DB_PUSH_MAX=24  # 24 × 5 s = 2 min ceiling
_DB_PUSH_N=0
until npx prisma db push 2>&1; do
  _DB_PUSH_N=$((_DB_PUSH_N + 1))
  if [ "$_DB_PUSH_N" -ge "$_DB_PUSH_MAX" ]; then
    echo "[srx] FATAL: MySQL still unreachable after ${_DB_PUSH_MAX} attempts." >&2
    exit 1
  fi
  echo "[srx] MySQL not ready yet — retrying in 5 s… (${_DB_PUSH_N}/${_DB_PUSH_MAX})"
  sleep 5
done

if [ -n "${SRX_WORKER_SCRIPT:-}" ]; then
  echo "[srx] worker mode: ${SRX_WORKER_SCRIPT} (user: $(whoami))…"
  exec npx tsx "${SRX_WORKER_SCRIPT}"
fi

echo "[srx] starting Next.js production server on 0.0.0.0:${PORT} (user: $(whoami))…"
export NODE_OPTIONS="${NODE_OPTIONS:---max-old-space-size=4096}"
exec npx next start --hostname 0.0.0.0 --port "${PORT}"
