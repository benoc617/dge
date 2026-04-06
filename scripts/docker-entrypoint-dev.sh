#!/bin/sh
set -e
cd /app

export PORT="${PORT:-3000}"

# node_modules is a named volume over /app/node_modules. If it was filled on the host (wrong OS),
# is empty, or optional native deps failed partially, Tailwind → lightningcss breaks at runtime.
# Directory checks are not enough (empty dirs, wrong arch); verify the native binding loads.
if ! node -e "require('lightningcss')" 2>/dev/null; then
  echo "[srx] lightningcss native binding missing or broken — running npm ci…"
  npm ci
fi
if ! node -e "require('lightningcss')" 2>/dev/null; then
  echo "[srx] FATAL: lightningcss still fails after npm ci. Remove the node_modules volume or fix optional deps." >&2
  exit 1
fi

echo "[srx] prisma generate + db push…"
npx prisma generate
npx prisma db push

echo "[srx] starting Next.js dev server on 0.0.0.0:${PORT}…"
exec npm run dev -- --hostname 0.0.0.0 --port "${PORT}"
