#!/usr/bin/env bash
# dispatch — spawn a headless dev-agent for an approved plan.
#
# Usage:
#   dispatch.sh <slug>                  → fresh dispatch
#   dispatch.sh --resume <slug>         → resume a dead session
#
# Creates a worktree, initialises a journal, generates a session UUID, records
# state in agents/_state.json, and spawns `claude -p --session-id <uuid>` as
# a detached child (nohup → PPID=1 on shell exit).

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$REPO_ROOT"

# Shared state_write helper (flocked). Defined in lib.sh so tick.sh uses the same.
# Also exposes load_pipeline_config (reads .coordinator-pipeline.json → PLAN_REPO + PROJECT).
. "$(dirname "$0")/lib.sh"

# Initialise state file + agents dir on fresh clones — tick.sh and dispatch.sh
# must both tolerate a missing _state.json.
mkdir -p agents agents/archive
if [ ! -f "$STATE_FILE" ]; then
  printf '{"plans":{},"agents":{},"last_tick":null}\n' > "$STATE_FILE"
fi

load_pipeline_config

MODE="fresh"
SLUG=""

while [ $# -gt 0 ]; do
  case "$1" in
    --resume) MODE="resume"; shift ;;
    *) SLUG="$1"; shift ;;
  esac
done

if [ -z "$SLUG" ]; then
  echo "usage: dispatch.sh [--resume] <slug>" >&2
  exit 2
fi

# Find the plan file.
#   Plan-repo mode (PLAN_REPO + PROJECT set): look in $PLAN_CACHE_DIR first
#   (populated by tick.sh); if absent, fetch directly from the plan-repo and
#   cache it, so `dispatch.sh <slug>` works even if tick.sh hasn't been run
#   recently.
#   Legacy mode: look in plans/ in the downstream repo.
PLAN_FILE=""
if [ -n "$PLAN_REPO" ]; then
  mkdir -p "$PLAN_CACHE_DIR"
  for candidate in "$PLAN_CACHE_DIR"/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-"$SLUG".md; do
    [ -f "$candidate" ] && PLAN_FILE="$candidate" && break
  done
  if [ -z "$PLAN_FILE" ]; then
    # Cache miss — query the plan-repo directly.
    remote_name="$(gh api "repos/$PLAN_REPO/contents/plans" \
      --jq ".[] | select(.type==\"file\") | select(.name | test(\"^[0-9]{4}-[0-9]{2}-[0-9]{2}-${SLUG}\\\\.md\$\")) | .name" 2>/dev/null \
      | head -1)"
    if [ -n "$remote_name" ]; then
      if gh api "repos/$PLAN_REPO/contents/plans/$remote_name" \
           --jq '.content' 2>/dev/null | base64 -d > "$PLAN_CACHE_DIR/$remote_name"; then
        PLAN_FILE="$PLAN_CACHE_DIR/$remote_name"
      else
        rm -f "$PLAN_CACHE_DIR/$remote_name"
      fi
    fi
  fi
else
  for candidate in plans/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-"$SLUG".md; do
    [ -f "$candidate" ] && PLAN_FILE="$candidate" && break
  done
fi

if [ -z "$PLAN_FILE" ]; then
  if [ -n "$PLAN_REPO" ]; then
    echo "plan file not found for slug '$SLUG' in $PLAN_REPO or $PLAN_CACHE_DIR" >&2
  else
    echo "plan file not found for slug: $SLUG" >&2
  fi
  exit 3
fi

DATE="$(basename "$PLAN_FILE" .md | grep -oE '^[0-9]{4}-[0-9]{2}-[0-9]{2}')"
JOURNAL="agents/$DATE-$SLUG.md"
WORKTREE="worktrees/$SLUG"
BRANCH="feat/$SLUG"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"

if [ "$MODE" = "resume" ]; then
  # Resume path: session UUID is already in state, journal exists, worktree exists.
  SESSION_ID="$(jq -r --arg slug "$SLUG" '.agents[$slug].session_id // empty' "$STATE_FILE")"
  if [ -z "$SESSION_ID" ]; then
    echo "no recorded session_id for slug: $SLUG" >&2
    exit 4
  fi

  # Sanity: make sure nothing is still running under this session UUID.
  # pgrep -f is PID-reuse-safe (session UUIDs are unique in claude's argv).
  if pgrep -f "$SESSION_ID" > /dev/null 2>&1; then
    echo "refusing to resume: a process matching session $SESSION_ID is still alive. Concurrent --resume would corrupt session JSONL." >&2
    exit 5
  fi

  [ -d "$WORKTREE" ] || git worktree add "$WORKTREE" "$BRANCH"

  nohup claude -p --resume "$SESSION_ID" \
    "Resume the task. Read your journal at $JOURNAL first. If --resume restored context, continue from the logged checkpoint. If the restored context is empty or corrupted, fall back to journal replay and pick up from the last clean checkpoint." \
    > "agents/$DATE-$SLUG.stdout.log" 2>&1 &

  NEW_PID=$!
  echo "resumed: slug=$SLUG session=$SESSION_ID pid=$NEW_PID"

else
  # Fresh dispatch
  [ ! -d "$WORKTREE" ] || { echo "worktree $WORKTREE already exists"; exit 6; }
  [ ! -f "$JOURNAL" ] || { echo "journal $JOURNAL already exists"; exit 7; }

  SESSION_ID="$(uuidgen | tr 'A-Z' 'a-z')"

  # Create worktree + link deps using ABSOLUTE paths (robust to layout changes).
  # Branch from origin/main explicitly — HEAD-independent, so a concurrent
  # session moving HEAD in the main working tree cannot leak unrelated commits
  # into the dev-agent's branch.
  git fetch origin main
  git worktree add "$WORKTREE" -b "$BRANCH" origin/main
  # Assert: new worktree is rooted at origin/main with zero stray commits.
  if ! (cd "$WORKTREE" && [ -z "$(git log origin/main..HEAD --oneline)" ]); then
    echo "worktree $WORKTREE is not rooted at origin/main — aborting dispatch" >&2
    git worktree remove --force "$WORKTREE" 2>/dev/null || true
    exit 8
  fi
  ln -sf "$REPO_ROOT/node_modules" "$WORKTREE/node_modules"
  ln -sf "$REPO_ROOT/.env" "$WORKTREE/.env"

  # Initialise journal
  cat > "$JOURNAL" <<EOF
---
plan: $PLAN_FILE
branch: $BRANCH
worktree: $WORKTREE
session_id: $SESSION_ID
status: in_progress
started: $NOW_ISO
last_heartbeat: $NOW_ISO
checkpoint: pending
files_touched: []
decisions: []
---

## Log

- $(date -u +%H:%M) | dispatch | fresh start, session $SESSION_ID
EOF

  # Record in _state.json (locked)
  state_write '.agents[$slug] = {
      plan: $plan,
      session_id: $session,
      pid: 0,
      worktree: $worktree,
      branch: $branch,
      started_at: $started,
      last_heartbeat: $started,
      checkpoint: "pending",
      status: "in_progress",
      stuck_ticks: 0
    }' \
    --arg slug "$SLUG" \
    --arg session "$SESSION_ID" \
    --arg plan "$PLAN_FILE" \
    --arg worktree "$WORKTREE" \
    --arg branch "$BRANCH" \
    --arg started "$NOW_ISO"

  # Spawn headless dev-agent (detached)
  nohup claude -p --session-id "$SESSION_ID" \
    "You are dev-agent. Execute the plan at $PLAN_FILE. Write your journal at $JOURNAL. Your session id is $SESSION_ID. Your worktree is $WORKTREE. Read the journal first; if it already has status: in_progress with a checkpoint, resume from there. Follow the dev-agent definition at .claude/agents/dev-agent.md precisely. When done, dispatch pr-reviewer on the feature PR." \
    > "agents/$DATE-$SLUG.stdout.log" 2>&1 &

  NEW_PID=$!
  echo "dispatched: slug=$SLUG session=$SESSION_ID pid=$NEW_PID"
fi

# Record PID (locked)
state_write '.agents[$slug].pid = ($pid | tonumber)' \
  --arg slug "$SLUG" \
  --arg pid "$NEW_PID"
