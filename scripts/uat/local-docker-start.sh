#!/usr/bin/env bash
set -euo pipefail

# local-docker-start.sh — start the local UAT Docker Compose stack.
# Usage: local-docker-start.sh <overlay-path>
#
# Runs docker compose up -d, then polls the app service healthcheck until
# it reports healthy. Exits non-zero on timeout, printing last 50 lines
# of app container log to stderr.

OVERLAY="${1:-}"
if [ -z "$OVERLAY" ]; then
  echo "[uat/start] ERROR: overlay path argument is required" >&2
  exit 1
fi

UAT_HEALTHCHECK_TIMEOUT="${UAT_HEALTHCHECK_TIMEOUT:-180}"

echo "[uat/start] Starting UAT stack with overlay: $OVERLAY"
docker compose -f "$OVERLAY" up -d

echo "[uat/start] Waiting for app service healthcheck (timeout: ${UAT_HEALTHCHECK_TIMEOUT}s)..."
deadline=$(( $(date +%s) + UAT_HEALTHCHECK_TIMEOUT ))

while true; do
  now=$(date +%s)
  if [ "$now" -ge "$deadline" ]; then
    echo "[uat/start] ERROR: healthcheck timed out after ${UAT_HEALTHCHECK_TIMEOUT}s" >&2
    echo "[uat/start] Last 50 lines of app container log:" >&2
    docker compose -f "$OVERLAY" logs --tail=50 app 2>&1 >&2 || true
    exit 1
  fi

  # Poll health status via docker compose ps JSON output
  health_status=$(docker compose -f "$OVERLAY" ps --format json 2>/dev/null \
    | python3 -c "
import sys, json
data = sys.stdin.read().strip()
# docker compose ps --format json may output a JSON array or newline-delimited objects
try:
    items = json.loads(data)
    if isinstance(items, list):
        for item in items:
            if item.get('Service') == 'app':
                print(item.get('Health', 'unknown'))
                sys.exit(0)
except Exception:
    pass
# Try newline-delimited
for line in data.splitlines():
    line = line.strip()
    if not line:
        continue
    try:
        item = json.loads(line)
        if item.get('Service') == 'app':
            print(item.get('Health', 'unknown'))
            sys.exit(0)
    except Exception:
        pass
print('unknown')
" 2>/dev/null || echo "unknown")

  if [ "$health_status" = "healthy" ]; then
    echo "[uat/start] App service is healthy."
    exit 0
  fi

  sleep 3
done
