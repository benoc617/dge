#!/usr/bin/env bash
# Rebuild the app image from the current repo and start the stack (picks up code + schema).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> docker compose up --build -d"
docker compose up --build -d

echo "==> done — http://localhost:3000 (Postgres on host: localhost:5433)"
