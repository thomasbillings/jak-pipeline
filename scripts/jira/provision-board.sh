#!/usr/bin/env bash
set -euo pipefail

# provision-board.sh — idempotent Jira board column provisioning.
#
# Usage:
#   provision-board.sh --project <KEY> --board <BOARD-ID>
#
# Ensures the 12 canonical kanban columns exist in the named board.
# Adds missing columns; NEVER deletes extras (future-proofing for custom columns).
#
# KNOWN LIMITATION (2026-05): Jira Cloud no longer exposes a REST endpoint to
# create board columns. POST /rest/agile/1.0/board/{id}/configuration/column
# returns HTTP 404 on every Cloud project type tested (company-managed AND
# team-managed). Board column-to-status mapping on Cloud is UI-only.
#
# This script will therefore log WARNs for every POST against a real Cloud
# instance and exit non-zero. The script as written remains useful as a
# *probe* — its failure mode confirms that manual UI provisioning is needed —
# but it can no longer provision columns end-to-end against Cloud.
#
# A future rewrite should provision STATUSES via POST /rest/api/3/workflows/create
# (the bulk-create-workflows API) and leave board column mapping as a
# documented manual UI step. Tracking issue: TBD (file once this lands).

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=lib/kanban-order.sh
source "${SCRIPT_DIR}/lib/kanban-order.sh"

PROJECT=""
BOARD_ID=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --board)   BOARD_ID="${2:-}"; shift 2 ;;
    *) echo "ERROR: unknown flag $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PROJECT" ]]; then echo "ERROR: --project is required" >&2; exit 1; fi
if [[ -z "$BOARD_ID" ]]; then echo "ERROR: --board is required" >&2; exit 1; fi

# Load credentials
JIRA_ENV_FILE="${JIRA_ENV_FILE:-}"
if [[ -z "$JIRA_ENV_FILE" ]]; then
  DOWNSTREAM_ROOT="${DOWNSTREAM_ROOT:-}"
  if [[ -n "$DOWNSTREAM_ROOT" ]] && [[ -f "$DOWNSTREAM_ROOT/.claude/jira/.env" ]]; then
    JIRA_ENV_FILE="$DOWNSTREAM_ROOT/.claude/jira/.env"
  fi
fi

if [[ -n "$JIRA_ENV_FILE" ]] && [[ -f "$JIRA_ENV_FILE" ]]; then
  set +u
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ ]] && continue
    [[ -z "$key" ]] && continue
    if [[ -z "${!key:-}" ]]; then export "$key"="$value"; fi
  done < "$JIRA_ENV_FILE"
  set -u
fi

JIRA_BASE_URL="${JIRA_BASE_URL:-}"
JIRA_EMAIL="${JIRA_EMAIL:-}"
JIRA_API_TOKEN="${JIRA_API_TOKEN:-}"

AUTH_HEADER="Authorization: Basic $(printf '%s:%s' "$JIRA_EMAIL" "$JIRA_API_TOKEN" | base64 | tr -d '\n')"

# Fetch existing columns
existing_json=$(curl -sf \
  -H "$AUTH_HEADER" -H "Content-Type: application/json" \
  --max-time 5 \
  "${JIRA_BASE_URL}/rest/agile/1.0/board/${BOARD_ID}/configuration" 2>/dev/null || echo '{"columnConfig":{"columns":[]}}')

# Extract existing column names
existing_names=$(echo "$existing_json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
cols = data.get('columnConfig', {}).get('columns', [])
for c in cols:
    print(c.get('name', ''))
" 2>/dev/null || true)

# Add any missing canonical states
added=0
failed=0
skipped=0
for state in "${KANBAN_STATES[@]}"; do
  if echo "$existing_names" | grep -qxF "$state"; then
    skipped=$(( skipped + 1 ))
    continue
  fi
  # Create the column
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "$AUTH_HEADER" -H "Content-Type: application/json" \
    --max-time 5 \
    -d "{\"name\":\"${state}\"}" \
    "${JIRA_BASE_URL}/rest/agile/1.0/board/${BOARD_ID}/configuration/column" 2>/dev/null || echo "000")
  if [[ "$http_code" == "2"* ]]; then
    echo "created column: $state"
    added=$(( added + 1 ))
  else
    echo "WARN: failed to create column '$state' (HTTP $http_code)" >&2
    failed=$(( failed + 1 ))
  fi
done

echo "provision-board: created=${added} failed=${failed} skipped=${skipped}"

if (( failed > 0 )); then
  echo "provision-board: ${failed} column(s) failed to create — see WARNs above." >&2
  if (( added == 0 && skipped == 0 )); then
    echo "provision-board: NOTE — Jira Cloud no longer accepts POSTs to /rest/agile/1.0/board/{id}/configuration/column." >&2
    echo "provision-board: Board column mapping on Cloud must be done manually via the UI." >&2
    echo "provision-board: See the KNOWN LIMITATION header in this script." >&2
  fi
  exit 1
fi
