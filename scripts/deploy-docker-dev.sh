#!/usr/bin/env bash
# Rebuild the app image from the current repo and recreate the container.
# With no bind mount, this is how new code reaches the dev server.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

SERVICE="${DOCKER_DEV_SERVICE:-app}"

if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
  echo "Usage: npm run deploy"
  echo "Runs: docker compose build ${SERVICE} && docker compose up -d ${SERVICE}"
  exit 0
fi

echo "deploy: docker compose build ${SERVICE}"
docker compose build "${SERVICE}"

echo "deploy: docker compose up -d ${SERVICE}"
docker compose up -d "${SERVICE}"

echo "deploy: done — wait for health, then http://localhost:3000"
