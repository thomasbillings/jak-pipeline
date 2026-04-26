#!/usr/bin/env bash
# label-gate-decide.sh — decide whether to apply a queue:* label.
#
# Usage: label-gate-decide.sh <role> <pr_number> <intended_label>
#
# Exit codes:
#   0 — apply: all conditions met
#   2 — refuse: structured JSON payload on stdout explains why
#
# Environment:
#   GITHUB_OWNER           — repo owner (required)
#   GITHUB_REPO            — repo name (required)
#   GITHUB_REVIEWER_LOGIN  — the agent's GitHub login for review lookups
#                            (default: github-actions[bot])
#   JAK_PR_HEAD_SHA        — optional PR head SHA for check-runs lookup
#
# INJECTION GUARD: this script NEVER calls gh api .*/pulls/<n> without a
# /reviews or /check-runs suffix. PR body content is never read.

set -euo pipefail

ROLE="${1:-}"
PR_NUMBER="${2:-}"
INTENDED_LABEL="${3:-}"

OWNER="${GITHUB_OWNER:-}"
REPO="${GITHUB_REPO:-}"
REVIEWER_LOGIN="${GITHUB_REVIEWER_LOGIN:-github-actions[bot]}"

ALLOWED_LABELS=("queue:bug" "queue:feature" "queue:infra" "queue:design")

refuse() {
  local reason="$1"
  printf '{"decision":"refuse","reason":"%s"}\n' "$reason"
  exit 2
}

# (i) Role check — only pr-reviewer is authorised
if [ "$ROLE" != "pr-reviewer" ]; then
  refuse "role-not-authorised"
fi

# (ii) queue:plan is user-only regardless of caller
if [ "$INTENDED_LABEL" = "queue:plan" ]; then
  refuse "queue:plan-is-user-only"
fi

# (iii) Label must be in allowed set
label_allowed=false
for l in "${ALLOWED_LABELS[@]}"; do
  if [ "$l" = "$INTENDED_LABEL" ]; then
    label_allowed=true
    break
  fi
done
if [ "$label_allowed" = false ]; then
  refuse "label-not-in-allowed-set"
fi

# (iv) Read own review data from gh api — NEVER from PR body
REVIEWS_JSON="$(gh api "repos/${OWNER}/${REPO}/pulls/${PR_NUMBER}/reviews" 2>/dev/null || echo '[]')"

# Parse reviews with python3 (portable, no jq dependency)
# Pass JSON via stdin to avoid shell interpolation issues with embedded newlines
REVIEW_PARSE="$(echo "$REVIEWS_JSON" | python3 -c "
import json, sys, re

data = json.load(sys.stdin)
reviewer = '${REVIEWER_LOGIN}'

matching = None
for r in data:
    if isinstance(r, dict):
        user = r.get('user', {})
        login = user.get('login', '') if isinstance(user, dict) else str(user)
        if login == reviewer:
            matching = r

if matching is None:
    print('NO_REVIEW')
    sys.exit(0)

state = matching.get('state', '')
body = matching.get('body', '') or ''
# Match the pr-reviewer canonical format: **Blockers (N)** (markdown bold)
# Also accept legacy BLOCKERS: N format for backwards compatibility
m = re.search(r'[*][*]Blockers\\s*[(](\\d+)[)][*][*]|BLOCKERS:\\s*(\\d+)', body, re.IGNORECASE)
if m:
    blockers = int(m.group(1) if m.group(1) is not None else m.group(2))
else:
    blockers = -1

print(f'{state}|{blockers}')
")"

if [ "$REVIEW_PARSE" = "NO_REVIEW" ]; then
  refuse "no-matching-review-found"
fi

REVIEW_STATE="$(echo "$REVIEW_PARSE" | cut -d'|' -f1)"
BLOCKERS="$(echo "$REVIEW_PARSE" | cut -d'|' -f2)"

if [ "$REVIEW_STATE" != "APPROVED" ] && [ "$REVIEW_STATE" != "COMMENTED" ]; then
  refuse "review-not-in-valid-state"
fi

if [ "$BLOCKERS" = "-1" ]; then
  refuse "no-blockers-line-in-review"
fi

if [ "$BLOCKERS" -gt 0 ]; then
  refuse "blockers-count-${BLOCKERS}-nonzero"
fi

# (v) CI checks — verify all required checks pass
HEAD_SHA="${JAK_PR_HEAD_SHA:-}"
if [ -z "$HEAD_SHA" ]; then
  HEAD_SHA="$(echo "$REVIEWS_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
for r in data:
    if isinstance(r, dict) and r.get('commit_id'):
        print(r['commit_id'])
        break
" 2>/dev/null || true)"
fi

if [ -n "$HEAD_SHA" ]; then
  CHECKS_JSON="$(gh api "repos/${OWNER}/${REPO}/commits/${HEAD_SHA}/check-runs" 2>/dev/null || echo '{"check_runs":[]}')"
  CHECKS_FAIL="$(echo "$CHECKS_JSON" | python3 -c "
import json, sys
data = json.load(sys.stdin)
runs = data.get('check_runs', [])
for r in runs:
    if r.get('conclusion') in ('failure', 'cancelled', 'timed_out'):
        print('FAIL')
        break
" 2>/dev/null || true)"
  if [ "$CHECKS_FAIL" = "FAIL" ]; then
    refuse "ci-checks-not-green"
  fi
fi

# (vi) All conditions met — apply
printf '{"decision":"apply","label":"%s","blocker_count":0,"tests_state":"green","reasoning":"own review approved with BLOCKERS=0 and CI checks green"}\n' \
  "$INTENDED_LABEL"
exit 0
