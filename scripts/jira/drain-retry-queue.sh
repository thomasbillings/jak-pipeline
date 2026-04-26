#!/usr/bin/env bash
set -euo pipefail

# drain-retry-queue.sh — drain agents/_jira-retry.json row-by-row.
#
# Reads the JSONL retry queue, calls transition.sh for each row, removes
# successful rows, and leaves failed rows with attempt_count incremented.
# Concurrent-safe via flock on a sibling .lock file.
# Exits 0 even when individual transitions fail (drain is best-effort).
#
# Design note: we read all queue rows into a bash array BEFORE starting
# to process them. This prevents the while-read loop from picking up
# lines that transition.sh appends to the queue file during drain.
# transition.sh is called with JIRA_RETRY_QUEUE=/dev/null so it does not
# double-write to the queue; drain owns the queue management here.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

JIRA_RETRY_QUEUE="${JIRA_RETRY_QUEUE:-agents/_jira-retry.json}"
LOCK_FILE="${JIRA_RETRY_QUEUE%.json}.lock"

# Load credentials from env file if provided
JIRA_ENV_FILE="${JIRA_ENV_FILE:-}"
if [[ -z "$JIRA_ENV_FILE" ]]; then
  DOWNSTREAM_ROOT="${DOWNSTREAM_ROOT:-}"
  if [[ -n "$DOWNSTREAM_ROOT" ]] && [[ -f "$DOWNSTREAM_ROOT/.claude/jira/.env" ]]; then
    JIRA_ENV_FILE="$DOWNSTREAM_ROOT/.claude/jira/.env"
  fi
fi

_do_drain() {
  if [[ ! -f "$JIRA_RETRY_QUEUE" ]]; then
    echo "drain-retry-queue: queue is empty (no file)"
    return 0
  fi

  # Read all rows into an array BEFORE processing to prevent loop re-read of
  # lines appended by transition.sh.
  local rows=()
  while IFS= read -r row || [[ -n "$row" ]]; do
    [[ -z "$row" ]] && continue
    rows+=("$row")
  done < "$JIRA_RETRY_QUEUE"

  if [[ ${#rows[@]} -eq 0 ]]; then
    echo "drain-retry-queue: queue is empty"
    return 0
  fi

  local tmp_file="${JIRA_RETRY_QUEUE}.tmp.$$"
  local succeeded=0
  local remaining=0

  for line in "${rows[@]}"; do
    [[ -z "$line" ]] && continue

    # Parse fields with one python3 invocation
    local parsed
    parsed=$(echo "$line" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
print(d.get('ticket',''))
print(d.get('project',''))
print(d.get('target_state',''))
print(d.get('reason',''))
print(str(d.get('attempt_count', 1)))
print(d.get('first_attempted_at',''))
" 2>/dev/null) || true

    local ticket project target_state reason attempt_count first_attempted_at
    ticket=$(echo "$parsed" | sed -n '1p')
    project=$(echo "$parsed" | sed -n '2p')
    target_state=$(echo "$parsed" | sed -n '3p')
    reason=$(echo "$parsed" | sed -n '4p')
    attempt_count=$(echo "$parsed" | sed -n '5p')
    first_attempted_at=$(echo "$parsed" | sed -n '6p')
    attempt_count="${attempt_count:-1}"

    if [[ -z "$ticket" ]] || [[ -z "$target_state" ]]; then
      echo "$line" >> "$tmp_file"
      remaining=$(( remaining + 1 ))
      continue
    fi

    # Run transition.sh once; set JIRA_RETRY_QUEUE=/dev/null so transition.sh
    # does not double-write to the queue — drain manages queue state itself.
    local transition_output
    transition_output=$(
      JIRA_ENV_FILE="$JIRA_ENV_FILE" \
      JIRA_RETRY_QUEUE="/dev/null" \
      JIRA_BACKOFF_SEED_MS="${JIRA_BACKOFF_SEED_MS:-2000}" \
      JIRA_BACKOFF_CAP_MS="${JIRA_BACKOFF_CAP_MS:-30000}" \
        bash "${SCRIPT_DIR}/transition.sh" \
          --project "$project" \
          --ticket "$ticket" \
          --to "$target_state" \
          --reason "$reason" \
          2>/dev/null
    ) || true

    if echo "$transition_output" | grep -qE "transitioned:|already at target"; then
      succeeded=$(( succeeded + 1 ))
      echo "drain: $ticket → $target_state succeeded"
    else
      # Keep the row with incremented attempt_count and updated timestamp
      local new_count=$(( attempt_count + 1 ))
      local now
      now="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
      local updated_row
      updated_row=$(echo "$line" | python3 -c "
import sys, json
d = json.loads(sys.stdin.read())
d['attempt_count'] = ${new_count}
d['last_attempted_at'] = '${now}'
print(json.dumps(d))
" 2>/dev/null) || updated_row="$line"
      echo "$updated_row" >> "$tmp_file"
      remaining=$(( remaining + 1 ))
      echo "drain: $ticket → $target_state still failing (attempt $new_count)" >&2
    fi
  done

  # Atomically replace the queue with the remaining rows
  if [[ -f "$tmp_file" ]]; then
    mv "$tmp_file" "$JIRA_RETRY_QUEUE"
  else
    rm -f "$JIRA_RETRY_QUEUE"
  fi

  echo "drain-retry-queue: $succeeded succeeded, $remaining remaining"
}

# Use flock for concurrent safety (non-blocking: second invocation skips)
if command -v flock >/dev/null 2>&1; then
  (
    flock -n 9 || { echo "drain-retry-queue: locked by another process, skipping"; exit 0; }
    _do_drain
  ) 9>"$LOCK_FILE" || true
else
  _do_drain || true
fi
