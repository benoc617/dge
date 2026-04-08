#!/usr/bin/env bash
# Full rebuild of the app image and stack. Use after dependency / native-binding issues or to clear
# a stale .next inside the container. Legacy named volumes from the old bind-mount setup are removed
# if they still exist.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

echo "==> stopping and removing app container"
docker compose stop app 2>/dev/null || true
docker compose rm -f app 2>/dev/null || true

for suffix in _srx_node_modules _srx_next; do
  VOL="$(docker volume ls -q | grep "${suffix}\$" | head -n1 || true)"
  label="${suffix#_srx_}"
  echo "==> removing legacy ${label} volume (if present)"
  if [[ -n "${VOL}" ]]; then
    echo "    ${VOL}"
    docker volume rm "${VOL}"
  else
    echo "    (none)"
  fi
done

echo "==> rebuild app image (no cache) + start stack"
docker compose build --no-cache app
docker compose up -d

echo "==> done — wait for app health, then http://localhost:3000"
echo "    If npm ci OOMs in the container, raise Docker memory."
