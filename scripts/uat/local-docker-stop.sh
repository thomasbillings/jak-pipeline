#!/usr/bin/env bash
set -euo pipefail

# local-docker-stop.sh — stop the local UAT Docker Compose stack.
# Usage: local-docker-stop.sh <overlay-path> [--volumes]
#
# Runs docker compose down --remove-orphans.
# Volumes are NOT removed by default; pass --volumes to opt in.

OVERLAY="${1:-}"
if [ -z "$OVERLAY" ]; then
  echo "[uat/stop] ERROR: overlay path argument is required" >&2
  exit 1
fi

REMOVE_VOLUMES=0
for arg in "${@:2}"; do
  if [ "$arg" = "--volumes" ]; then
    REMOVE_VOLUMES=1
  fi
done

DOWN_ARGS=(-f "$OVERLAY" down --remove-orphans)
if [ "$REMOVE_VOLUMES" -eq 1 ]; then
  DOWN_ARGS+=(--volumes)
fi

echo "[uat/stop] Stopping UAT stack..."
if ! docker compose "${DOWN_ARGS[@]}"; then
  echo "[uat/stop] ERROR: docker compose down failed" >&2
  exit 1
fi

echo "[uat/stop] UAT stack stopped."
