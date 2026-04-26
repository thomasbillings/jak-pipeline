#!/usr/bin/env bash
set -euo pipefail

# local-docker-reject.sh — reject UAT for a ticket, post PR comment, tear down.
# Usage: local-docker-reject.sh <ticket-key> <overlay-path> <reason>
#
# Calls scripts/jira/transition.sh to move ticket UAT → PR Review (fix-forward).
# Posts a gh pr comment with the rejection reason on the originating PR.
# ALWAYS tears down the UAT stack.

TICKET="${1:-}"
OVERLAY="${2:-}"
REASON="${3:-UAT rejected}"

if [ -z "$TICKET" ] || [ -z "$OVERLAY" ]; then
  echo "[uat/reject] ERROR: usage: local-docker-reject.sh <ticket-key> <overlay-path> [reason]" >&2
  exit 1
fi

SCRIPT_DIR="${JAK_UAT_SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
JAK_SKILL_ROOT="${JAK_SKILL_ROOT:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)}"
TRANSITION_SH="${JAK_SKILL_ROOT}/scripts/jira/transition.sh"
STOP_SH="${SCRIPT_DIR}/local-docker-stop.sh"
GH_PR_NUMBER="${GH_PR_NUMBER:-}"

# Extract project key from ticket (e.g. SCRUM-7 → SCRUM, GH-7 → GH)
PROJECT="${TICKET%%-*}"

# Transition UAT → PR Review (fix-forward path per architecture.md §9)
if [ -f "$TRANSITION_SH" ]; then
  bash "$TRANSITION_SH" \
    --project "$PROJECT" \
    --ticket "$TICKET" \
    --to "PR Review" \
    --reason "UAT rejected: $REASON" || true
else
  echo "[uat/reject] WARN: transition.sh not found at $TRANSITION_SH — skipping Jira transition" >&2
fi

# Post rejection comment on the originating PR
if [ -n "$GH_PR_NUMBER" ]; then
  gh pr comment "$GH_PR_NUMBER" \
    --body "**UAT rejected** for ${TICKET}: ${REASON}

Ticket moved back to PR Review. A fix-forward PR is required." || true
else
  echo "[uat/reject] WARN: GH_PR_NUMBER not set — cannot post PR comment" >&2
fi

# Always tear down
bash "$STOP_SH" "$OVERLAY"
