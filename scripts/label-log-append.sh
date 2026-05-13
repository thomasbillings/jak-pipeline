#!/usr/bin/env bash
# label-log-append.sh — append a JSONL row to agents/_label-log.jsonl.
#
# Usage: label-log-append.sh <applied_by> <pr_number> <label> <blocker_count> <tests_state> <reasoning>
#
# Idempotent at minute granularity: if a row with the same applied_by+pr_number+label
# already exists AND its applied_at shares the same YYYY-MM-DDTHH:MM prefix as the
# current time (or JAK_NOW_OVERRIDE), the script is a no-op (exit 0).
#
# JAK_PROJECT_ROOT — downstream project root; defaults to $PWD.
# JAK_NOW_OVERRIDE — ISO 8601 timestamp override for testing.

set -euo pipefail

if [ $# -lt 6 ]; then
  echo "Usage: label-log-append.sh <applied_by> <pr_number> <label> <blocker_count> <tests_state> <reasoning>" >&2
  exit 1
fi

APPLIED_BY="$1"
PR_NUMBER="$2"
LABEL="$3"
BLOCKER_COUNT="$4"
TESTS_STATE="$5"
REASONING="$6"

PROJECT_ROOT="${JAK_PROJECT_ROOT:-$PWD}"
LOG_DIR="${PROJECT_ROOT}/agents"
LOG_FILE="${LOG_DIR}/_label-log.jsonl"

# Determine current timestamp (overridable for tests)
if [ -n "${JAK_NOW_OVERRIDE:-}" ]; then
  NOW="${JAK_NOW_OVERRIDE}"
else
  NOW="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
fi

# Minute prefix for idempotency check (YYYY-MM-DDTHH:MM)
NOW_MINUTE="${NOW:0:16}"

# Idempotency check: look for an existing row with same applied_by+pr_number+label
# within the same UTC minute
if [ -f "$LOG_FILE" ]; then
  while IFS= read -r line; do
    if [ -z "$line" ]; then continue; fi
    row_applied_by="$(echo "$line" | grep -o '"applied_by":"[^"]*"' | cut -d'"' -f4)"
    row_pr_number="$(echo "$line" | grep -o '"pr_number":[0-9]*' | cut -d':' -f2)"
    row_label="$(echo "$line" | grep -o '"label":"[^"]*"' | cut -d'"' -f4)"
    row_applied_at="$(echo "$line" | grep -o '"applied_at":"[^"]*"' | cut -d'"' -f4)"
    row_minute="${row_applied_at:0:16}"

    if [ "$row_applied_by" = "$APPLIED_BY" ] \
      && [ "$row_pr_number" = "$PR_NUMBER" ] \
      && [ "$row_label" = "$LABEL" ] \
      && [ "$row_minute" = "$NOW_MINUTE" ]; then
      # Duplicate within same minute — no-op
      exit 0
    fi
  done < "$LOG_FILE"
fi

# Create directory and file if needed
mkdir -p "$LOG_DIR"

# JSON-escape a string: backslash → \\, double-quote → \", control chars stripped
json_escape() {
  printf '%s' "$1" | python3 -c "import sys,json; print(json.dumps(sys.stdin.read())[1:-1])"
}

APPLIED_BY_ESC="$(json_escape "$APPLIED_BY")"
LABEL_ESC="$(json_escape "$LABEL")"
TESTS_STATE_ESC="$(json_escape "$TESTS_STATE")"
REASONING_ESC="$(json_escape "$REASONING")"
NOW_ESC="$(json_escape "$NOW")"

# blocker_count is numeric for agent-applied rows. Architecture §7 permits
# "N/A" for user-applied rows (e.g. queue:plan). Emit as JSON null in that
# case, otherwise as an integer.
if [[ "$BLOCKER_COUNT" =~ ^[0-9]+$ ]]; then
  BLOCKER_COUNT_JSON="$BLOCKER_COUNT"
else
  BLOCKER_COUNT_JSON="null"
fi

# Append JSONL row (all string fields are JSON-escaped; blocker_count emitted
# unquoted so JSON parsers see it as a number or null).
printf '{"applied_by":"%s","pr_number":%d,"label":"%s","blocker_count":%s,"tests_state":"%s","reasoning":"%s","applied_at":"%s"}\n' \
  "$APPLIED_BY_ESC" \
  "$PR_NUMBER" \
  "$LABEL_ESC" \
  "$BLOCKER_COUNT_JSON" \
  "$TESTS_STATE_ESC" \
  "$REASONING_ESC" \
  "$NOW_ESC" \
  >> "$LOG_FILE"
