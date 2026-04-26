#!/usr/bin/env bash
set -euo pipefail

# transition.sh — idempotent Jira ticket transition helper.
#
# Usage:
#   transition.sh --project <KEY> --ticket <KEY> --to <TARGET-STATE> --reason <TEXT>
#
# Env vars (can also live in JIRA_ENV_FILE):
#   JIRA_BASE_URL       Base URL of the Jira instance
#   JIRA_EMAIL          Jira account email
#   JIRA_API_TOKEN      Jira API token
#   JIRA_PROJECT        Default project key
#   JIRA_ENV_FILE       Path to env file (default: <downstream>/.claude/jira/.env)
#   JIRA_RETRY_QUEUE    Path to JSONL retry queue (default: agents/_jira-retry.json)
#   JIRA_BACKOFF_SEED_MS  Exponential backoff seed in milliseconds (default: 2000)
#   JIRA_BACKOFF_CAP_MS   Exponential backoff cap in milliseconds (default: 30000)
#
# Contract (architecture.md §8):
#   1. Read-before-write: skip if already at target
#   2. Never-backwards: refuse if target is earlier in kanban order
#   3. Verify-after-write: re-fetch and assert new state
#   4. Retry 3x exponential backoff on transient failures
#   5. Fall through to _jira-retry.json on persistent failure
#   6. Exit 0 always — NEVER block the GitHub pipeline on Jira failure

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Source kanban ordering helper
# shellcheck source=lib/kanban-order.sh
source "${SCRIPT_DIR}/lib/kanban-order.sh"

# ---------------------------------------------------------------------------
# Argument parsing (must succeed or exit non-zero — this is CLI validation)
# ---------------------------------------------------------------------------
PROJECT=""
TICKET=""
TARGET_STATE=""
REASON=""

while [[ $# -gt 0 ]]; do
  case "$1" in
    --project) PROJECT="${2:-}"; shift 2 ;;
    --ticket)  TICKET="${2:-}"; shift 2 ;;
    --to)      TARGET_STATE="${2:-}"; shift 2 ;;
    --reason)  REASON="${2:-}"; shift 2 ;;
    *) echo "ERROR: unknown flag $1" >&2; exit 1 ;;
  esac
done

if [[ -z "$PROJECT" ]]; then echo "ERROR: --project is required" >&2; exit 1; fi
if [[ -z "$TICKET" ]];  then echo "ERROR: --ticket is required" >&2; exit 1; fi
if [[ -z "$TARGET_STATE" ]]; then echo "ERROR: --to is required" >&2; exit 1; fi
if [[ -z "$REASON" ]];  then echo "ERROR: --reason is required" >&2; exit 1; fi

# ---------------------------------------------------------------------------
# Load credentials from env file, then env vars override
# ---------------------------------------------------------------------------
JIRA_ENV_FILE="${JIRA_ENV_FILE:-}"
if [[ -z "$JIRA_ENV_FILE" ]]; then
  # Try to infer from DOWNSTREAM_ROOT
  DOWNSTREAM_ROOT="${DOWNSTREAM_ROOT:-}"
  if [[ -n "$DOWNSTREAM_ROOT" ]] && [[ -f "$DOWNSTREAM_ROOT/.claude/jira/.env" ]]; then
    JIRA_ENV_FILE="$DOWNSTREAM_ROOT/.claude/jira/.env"
  fi
fi

if [[ -n "$JIRA_ENV_FILE" ]] && [[ -f "$JIRA_ENV_FILE" ]]; then
  # shellcheck disable=SC1090
  set +u
  # Source the file but don't override already-set env vars
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ ]] && continue
    [[ -z "$key" ]] && continue
    # Strip surrounding quotes (single or double) from value
    value="${value%\"}"
    value="${value#\"}"
    value="${value%\'}"
    value="${value#\'}"
    # Only set if not already set in the environment
    if [[ -z "${!key:-}" ]]; then
      export "$key"="$value"
    fi
  done < "$JIRA_ENV_FILE"
  set -u
fi

JIRA_BASE_URL="${JIRA_BASE_URL:-}"
JIRA_EMAIL="${JIRA_EMAIL:-}"
JIRA_API_TOKEN="${JIRA_API_TOKEN:-}"
JIRA_RETRY_QUEUE="${JIRA_RETRY_QUEUE:-agents/_jira-retry.json}"

# Backoff settings (overridable via env for tests)
SEED_MS="${JIRA_BACKOFF_SEED_MS:-2000}"
CAP_MS="${JIRA_BACKOFF_CAP_MS:-30000}"

# ---------------------------------------------------------------------------
# Helpers: exit-0 on any Jira failure (never block the pipeline)
# ---------------------------------------------------------------------------
_AUTH_HEADER="Authorization: Basic $(printf '%s:%s' "$JIRA_EMAIL" "$JIRA_API_TOKEN" | base64 | tr -d '\n')"

jira_get() {
  local url="$1"
  curl -sf -H "$_AUTH_HEADER" -H "Content-Type: application/json" \
    --max-time 10 --retry 0 \
    "${JIRA_BASE_URL}${url}" 2>/dev/null || true
}

jira_post() {
  local url="$1"
  local body="$2"
  local http_code
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST \
    -H "$_AUTH_HEADER" \
    -H "Content-Type: application/json" \
    --max-time 15 --retry 0 \
    -d "$body" \
    "${JIRA_BASE_URL}${url}" 2>/dev/null || echo "000")
  echo "$http_code"
}

_append_retry_queue() {
  local last_error="$1"
  local now
  now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  FIRST_AT="${_FIRST_ATTEMPTED_AT:-$now}"

  local row
  row="$(printf '{"project":"%s","ticket":"%s","target_state":"%s","reason":"%s","first_attempted_at":"%s","last_attempted_at":"%s","attempt_count":%d,"last_error":"%s"}' \
    "$PROJECT" "$TICKET" "$TARGET_STATE" "$REASON" "$FIRST_AT" "$now" "$_ATTEMPT_COUNT" \
    "$(echo "$last_error" | sed 's/"/\\"/g')")"

  local lock_file="${JIRA_RETRY_QUEUE%.json}.lock"
  mkdir -p "$(dirname "$JIRA_RETRY_QUEUE")"
  if command -v flock >/dev/null 2>&1; then
    (
      flock 9
      printf '%s\n' "$row" >> "$JIRA_RETRY_QUEUE"
    ) 9>"$lock_file" || printf '%s\n' "$row" >> "$JIRA_RETRY_QUEUE"
  else
    printf '%s\n' "$row" >> "$JIRA_RETRY_QUEUE"
  fi
  echo "JIRA_RETRY: $TICKET → $TARGET_STATE queued for retry (attempt $_ATTEMPT_COUNT)" >&2
}

_sleep_ms() {
  local ms="$1"
  local secs
  # Use bc if available, else integer arithmetic
  if command -v bc >/dev/null 2>&1; then
    secs=$(echo "scale=3; $ms/1000" | bc)
  else
    secs=$(( ms / 1000 ))
  fi
  sleep "$secs" 2>/dev/null || true
}

# ---------------------------------------------------------------------------
# Main logic — wrapped in a function so we can set || exit 0 at the end
# ---------------------------------------------------------------------------
_main() {
  # 1. Read-before-write: fetch current state
  local current_json
  current_json="$(jira_get "/rest/api/3/issue/${TICKET}")"
  if [[ -z "$current_json" ]]; then
    echo "JIRA_WARN: failed to read current state of $TICKET" >&2
    _ATTEMPT_COUNT=1 _FIRST_ATTEMPTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    _append_retry_queue "failed to read current state"
    return 0
  fi

  local current_state
  current_state="$(echo "$current_json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('fields', {}).get('status', {}).get('name', ''))
" 2>/dev/null || true)"

  # 1a. Already at target — skip
  if [[ "$current_state" == "$TARGET_STATE" ]]; then
    echo "already at target: $TICKET is already in '$TARGET_STATE'"
    return 0
  fi

  # 2. Never-backwards check
  if kanban_is_backward "$current_state" "$TARGET_STATE"; then
    echo "refused: backward transition — $TICKET is at '$current_state', target '$TARGET_STATE' is earlier in kanban order"
    return 0
  fi

  # 3. Find the transition ID for TARGET_STATE
  local transitions_json
  transitions_json="$(jira_get "/rest/api/3/issue/${TICKET}/transitions")"
  local transition_id
  transition_id="$(echo "$transitions_json" | grep -B1 "\"name\":\"${TARGET_STATE}\"" | grep '"id"' | head -1 | sed 's/.*"id":"\([^"]*\)".*/\1/' || true)"

  if [[ -z "$transition_id" ]]; then
    # Try alternative JSON parsing
    transition_id="$(echo "$transitions_json" | TARGET_STATE="$TARGET_STATE" python3 -c "
import sys, json, os
data = json.load(sys.stdin)
target = os.environ['TARGET_STATE']
for t in data.get('transitions', []):
    if t.get('name') == target or t.get('to', {}).get('name') == target:
        print(t['id'])
        break
" 2>/dev/null || true)"
  fi

  if [[ -z "$transition_id" ]]; then
    echo "JIRA_WARN: no transition to '$TARGET_STATE' found for $TICKET (from '$current_state')" >&2
    _ATTEMPT_COUNT=1 _FIRST_ATTEMPTED_AT="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    _append_retry_queue "no transition id found for target state"
    return 0
  fi

  # 4. Attempt the transition with retry + exponential backoff
  local attempt=0
  local max_attempts=3
  local delay_ms=$SEED_MS
  local http_code
  local last_error=""
  local first_attempted_at
  first_attempted_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  local post_body
  post_body="{\"transition\":{\"id\":\"${transition_id}\"}}"

  while [[ $attempt -lt $max_attempts ]]; do
    attempt=$(( attempt + 1 ))

    http_code="$(jira_post "/rest/api/3/issue/${TICKET}/transitions" "$post_body")"

    if [[ "$http_code" == "2"* ]]; then
      # 5. Verify-after-write: re-fetch and assert
      local verify_json verify_state
      verify_json="$(jira_get "/rest/api/3/issue/${TICKET}")"
      verify_state="$(echo "$verify_json" | python3 -c "
import sys, json
data = json.load(sys.stdin)
print(data.get('fields', {}).get('status', {}).get('name', ''))
" 2>/dev/null || true)"

      if [[ "$verify_state" == "$TARGET_STATE" ]]; then
        echo "transitioned: $TICKET → '$TARGET_STATE' (reason: $REASON)"
        return 0
      else
        last_error="verify mismatch: expected '$TARGET_STATE' got '$verify_state' after HTTP $http_code"
        echo "JIRA_WARN: $last_error (attempt $attempt/$max_attempts)" >&2
      fi
    else
      last_error="HTTP $http_code from POST transition"
      echo "JIRA_WARN: $last_error (attempt $attempt/$max_attempts)" >&2
    fi

    # Don't sleep after the last attempt
    if [[ $attempt -lt $max_attempts ]]; then
      _sleep_ms "$delay_ms"
      # Double the delay, capped at CAP_MS
      delay_ms=$(( delay_ms * 2 ))
      if [[ $delay_ms -gt $CAP_MS ]]; then
        delay_ms=$CAP_MS
      fi
    fi
  done

  # 6. All attempts exhausted — append to retry queue and exit 0
  _ATTEMPT_COUNT=$max_attempts
  _FIRST_ATTEMPTED_AT="$first_attempted_at"
  _append_retry_queue "$last_error"
  return 0
}

# Safety net: exit 0 even if _main somehow raises an error
_main || true
