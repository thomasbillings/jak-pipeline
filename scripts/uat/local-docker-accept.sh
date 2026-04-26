#!/usr/bin/env bash
set -euo pipefail

# local-docker-accept.sh — accept UAT for a ticket and tear down the stack.
# Usage: local-docker-accept.sh <ticket-key> <overlay-path>
#
# Calls scripts/jira/transition.sh to move ticket UAT → Done.
# On Jira failure, appends to _jira-retry.json (best-effort) and continues.
# ALWAYS tears down the UAT stack, regardless of Jira outcome.

TICKET="${1:-}"
OVERLAY="${2:-}"

if [ -z "$TICKET" ] || [ -z "$OVERLAY" ]; then
  echo "[uat/accept] ERROR: usage: local-docker-accept.sh <ticket-key> <overlay-path>" >&2
  exit 1
fi

SCRIPT_DIR="${JAK_UAT_SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
JAK_SKILL_ROOT="${JAK_SKILL_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
TRANSITION_SH="${JAK_SKILL_ROOT}/scripts/jira/transition.sh"
STOP_SH="${SCRIPT_DIR}/local-docker-stop.sh"

# Best-effort Jira transition: UAT → Done
JIRA_OK=1
if [ -f "$TRANSITION_SH" ]; then
  bash "$TRANSITION_SH" \
    --ticket "$TICKET" \
    --to "Done" \
    --reason "UAT accepted" || JIRA_OK=0
else
  echo "[uat/accept] WARN: transition.sh not found at $TRANSITION_SH — skipping Jira transition" >&2
  JIRA_OK=0
fi

if [ "$JIRA_OK" -eq 0 ]; then
  echo "[uat/accept] WARN: Jira transition failed — recording in retry queue" >&2
  RETRY_FILE="${JAK_JIRA_RETRY_FILE:-${DOWNSTREAM_ROOT:-$PWD}/agents/_jira-retry.json}"
  mkdir -p "$(dirname "$RETRY_FILE")" 2>/dev/null || true
  printf '%s\n' "$(python3 -c "
import json, datetime
print(json.dumps({
  'ticket': '${TICKET}',
  'target_state': 'Done',
  'reason': 'UAT accepted',
  'first_attempted_at': datetime.datetime.utcnow().isoformat() + 'Z',
  'last_attempted_at': datetime.datetime.utcnow().isoformat() + 'Z',
  'attempt_count': 1,
  'last_error': 'accept script: Jira transition failed'
}))" 2>/dev/null || echo "{\"ticket\":\"${TICKET}\",\"target_state\":\"Done\"}")" >> "$RETRY_FILE" 2>/dev/null || true
fi

# Always tear down (UAT acceptance is recorded on the merged PR; Jira drift is reportable, not blocking)
bash "$STOP_SH" "$OVERLAY"
