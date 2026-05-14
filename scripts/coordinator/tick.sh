#!/usr/bin/env bash
# coordinator-tick — scan plans + agents + GitHub state, reconcile, report deltas.
#
# Read-only on running sub-agent sessions (observation, never poke).
# Updates agents/_state.json and appends to agents/_tick-log.md.
# Exits 0 on success; non-zero on unrecoverable state (e.g. git pull failed).
#
# Output: JSON summary to stdout. The slash command turns this into a human report.

set -euo pipefail

REPO_ROOT="${REPO_ROOT:-$(git rev-parse --show-toplevel)}"
cd "$REPO_ROOT"

# Shared state_write (flocked); sets STATE_FILE default. Also exposes
# load_pipeline_config (reads .coordinator-pipeline.json → PLAN_REPO + PROJECT).
. "$(dirname "$0")/lib.sh"

TICK_LOG="agents/_tick-log.md"
NOW_ISO="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
NOW_EPOCH="$(date +%s)"

mkdir -p agents agents/archive

# Initialize state file if missing
if [ ! -f "$STATE_FILE" ]; then
  printf '{"plans":{},"agents":{},"last_tick":null}\n' > "$STATE_FILE"
fi

# Load pipeline config — sets PLAN_REPO + PROJECT (empty strings in legacy mode).
load_pipeline_config

# Refresh the remote ref for main; do NOT touch the working tree — the
# coordinator may be running from a feature branch or worktree.
git fetch origin main --quiet || {
  echo '{"error":"git fetch failed — check network/auth"}' >&2
  exit 1
}

# ---- 1. Discover eligible plans ----
# Two modes:
#   A. Plan-repo mode (PLAN_REPO + PROJECT set): eligible plans are merged
#      plan files on $PLAN_REPO:main matching plans/YYYY-MM-DD-<slug>.md,
#      with `schema_version: 1` AND `project: $PROJECT` in frontmatter.
#      Content is cached locally under $PLAN_CACHE_DIR/ so dispatch.sh
#      can fetch it without a second round-trip. Requires `gh` auth'd
#      against $PLAN_REPO.
#   B. Legacy mode (config absent): eligible plans are merged files on
#      origin/main of the downstream repo with `schema_version: 1`.
ELIGIBLE_PLANS=()

if [ -n "$PLAN_REPO" ]; then
  mkdir -p "$PLAN_CACHE_DIR"
  # List every file under plans/*.md on $PLAN_REPO:main via the Contents API.
  # `type=file` filters out the plans/.gitkeep entry if present.
  while IFS= read -r plan_name; do
    [ -z "$plan_name" ] && continue
    if [[ ! "$plan_name" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-.+\.md$ ]]; then
      continue
    fi
    # Fetch raw content (base64) and decode into the cache. `tick.sh` is
    # idempotent so we overwrite on every tick — cheap, and avoids drift.
    if ! gh api "repos/$PLAN_REPO/contents/plans/$plan_name" \
         --jq '.content' 2>/dev/null | base64 -d > "$PLAN_CACHE_DIR/$plan_name"; then
      echo "coordinator-pipeline: failed to fetch $PLAN_REPO:plans/$plan_name — skipping" >&2
      rm -f "$PLAN_CACHE_DIR/$plan_name"
      continue
    fi
    # Filter: must have schema_version: 1 AND project: $PROJECT.
    # Use grep -E (extended regex) for portability: BSD grep (macOS) does
    # NOT support the \| alternation in basic regex; GNU grep does. -E
    # works on both.
    if grep -q '^schema_version: 1$' "$PLAN_CACHE_DIR/$plan_name" \
       && grep -Eq "^project: (${PROJECT}|'${PROJECT}'|\"${PROJECT}\")$" "$PLAN_CACHE_DIR/$plan_name"; then
      slug="$(basename "$plan_name" .md | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}-//')"
      ELIGIBLE_PLANS+=("$slug")
    else
      # Not for this project (or not schema_version 1) — drop the cached copy.
      rm -f "$PLAN_CACHE_DIR/$plan_name"
    fi
  done < <(gh api "repos/$PLAN_REPO/contents/plans" --jq '.[] | select(.type=="file") | .name' 2>/dev/null || true)
else
  # Legacy mode: read from local origin/main.
  while IFS= read -r plan; do
    [ -z "$plan" ] && continue
    # Only consider dated plan filenames
    if [[ ! "$plan" =~ ^plans/[0-9]{4}-[0-9]{2}-[0-9]{2}-.+\.md$ ]]; then
      continue
    fi
    # Inspect frontmatter on origin/main, not working tree.
    if git show "origin/main:$plan" 2>/dev/null | grep -q '^schema_version: 1$'; then
      slug="$(basename "$plan" .md | sed -E 's/^[0-9]{4}-[0-9]{2}-[0-9]{2}-//')"
      ELIGIBLE_PLANS+=("$slug")
    fi
  done < <(git ls-tree -r --name-only origin/main -- plans/)
fi

# ---- 2. Classify agents ----
#
# Per entry in _state.json .agents:
#   - PID alive + heartbeat < 5min  → healthy
#   - PID alive + heartbeat 5–10min → watching
#   - PID alive + heartbeat > 10min → stuck (increment counter)
#   - PID dead + status in_progress → dead (resume candidate)
#   - status: done → reconcile with PR state

CLASSIFIED="$(jq -n --arg now "$NOW_EPOCH" --slurpfile state "$STATE_FILE" '
  ($state[0].agents // {}) as $agents
  | [
      $agents
      | to_entries[]
      | . as $entry
      | ($entry.key) as $slug
      | ($entry.value) as $a
      | ($a.pid // 0) as $pid
      | ($a.last_heartbeat // null) as $hb
      | ($a.status // "unknown") as $status
      | ($a.checkpoint // "unknown") as $cp
      | ($a.stuck_ticks // 0) as $stuck
      | { slug: $slug, pid: $pid, last_heartbeat: $hb, status: $status, checkpoint: $cp, stuck_ticks: $stuck }
    ]
')"

# For each classified agent, check PID liveness + heartbeat age.
NEW_AGENT_STATE="$(printf '%s' "$CLASSIFIED" | jq -c '.[]' | while read -r agent_json; do
  slug="$(echo "$agent_json" | jq -r '.slug')"
  pid="$(echo "$agent_json" | jq -r '.pid')"
  hb="$(echo "$agent_json" | jq -r '.last_heartbeat // empty')"
  status="$(echo "$agent_json" | jq -r '.status')"
  checkpoint="$(echo "$agent_json" | jq -r '.checkpoint')"
  stuck="$(echo "$agent_json" | jq -r '.stuck_ticks')"

  # Liveness: cross-check recorded PID against pgrep for the session UUID.
  # session_id is unique per dispatch and appears in claude's argv, so
  # pgrep -f "$session_id" is PID-reuse-safe. kill -0 alone isn't.
  session_id="$(jq -r --arg slug "$slug" '.agents[$slug].session_id // empty' "$STATE_FILE")"
  alive="false"
  if [ -n "$session_id" ] && pgrep -f "$session_id" > /dev/null 2>&1; then
    if [ "$pid" != "0" ] && [ "$pid" != "null" ] && kill -0 "$pid" 2>/dev/null; then
      alive="true"
    fi
  fi

  hb_age="null"
  if [ -n "$hb" ]; then
    # Portable ISO8601 → epoch: try BSD (-j -f) first, fall back to GNU (-d).
    hb_epoch="$(date -j -f "%Y-%m-%dT%H:%M:%SZ" "$hb" +%s 2>/dev/null \
                || date -d "$hb" +%s 2>/dev/null \
                || echo "")"
    if [ -n "$hb_epoch" ]; then
      hb_age="$(( NOW_EPOCH - hb_epoch ))"
    fi
  fi

  # Classify
  new_status="$status"
  new_stuck="$stuck"
  classification="unknown"

  if [ "$status" = "done" ]; then
    classification="done"
  elif [ "$alive" = "true" ]; then
    if [ "$hb_age" != "null" ] && [ "$hb_age" -lt 300 ]; then
      classification="healthy"
      new_stuck=0
    elif [ "$hb_age" != "null" ] && [ "$hb_age" -lt 600 ]; then
      classification="watching"
    else
      classification="stuck"
      new_stuck=$(( stuck + 1 ))
    fi
  else
    classification="dead"
    new_status="dead"
  fi

  jq -n --arg slug "$slug" \
        --arg pid "$pid" \
        --arg hb "$hb" \
        --arg hb_age "$hb_age" \
        --arg alive "$alive" \
        --arg cp "$checkpoint" \
        --arg new_status "$new_status" \
        --arg new_stuck "$new_stuck" \
        --arg classification "$classification" \
        '{
          slug: $slug,
          pid: ($pid | tonumber? // 0),
          alive: ($alive == "true"),
          last_heartbeat: $hb,
          heartbeat_age_seconds: ($hb_age | tonumber? // null),
          checkpoint: $cp,
          status: $new_status,
          stuck_ticks: ($new_stuck | tonumber),
          classification: $classification
        }'
done | jq -s '.')"

# ---- 3. Detect newly-eligible plans (approved but not yet dispatched) ----
NEW_PLANS="$(jq -n --argjson eligible "$(printf '%s\n' "${ELIGIBLE_PLANS[@]:-}" | jq -R . | jq -s .)" \
                   --slurpfile state "$STATE_FILE" \
                   --argjson agents "$NEW_AGENT_STATE" '
  ($state[0].plans // {}) as $plans
  | $eligible
  | map(select(. != ""))
  | map(
      . as $slug
      | {
          slug: $slug,
          in_state: ($plans | has($slug)),
          has_agent: ($agents | map(.slug) | index($slug) != null),
          state: ($plans[$slug].status // "new")
        }
    )
')"

# ---- 4. Emit summary ----
jq -n --argjson plans "$NEW_PLANS" \
      --argjson agents "$NEW_AGENT_STATE" \
      --arg now "$NOW_ISO" '
  {
    tick_at: $now,
    eligible_plans: $plans,
    agents: $agents
  }
'

# ---- 5. Persist updated state (flocked) ----
state_write '
  .last_tick = $now
  | .agents = (
      (.agents // {}) as $existing
      | $new_agents
      | map({(.slug): (
          ($existing[.slug] // {}) + {
            pid: .pid,
            last_heartbeat: .last_heartbeat,
            checkpoint: .checkpoint,
            status: .status,
            stuck_ticks: .stuck_ticks
          }
        )})
      | add // {}
    )
' --argjson new_agents "$NEW_AGENT_STATE" --arg now "$NOW_ISO"

# ---- 6. Append deltas to tick log ----
{
  echo ""
  echo "## $NOW_ISO"
  printf '%s' "$NEW_AGENT_STATE" | jq -r '.[] | "- " + .slug + " | " + .checkpoint + " | " + .classification + (if .stuck_ticks > 0 then " (stuck " + (.stuck_ticks|tostring) + "×)" else "" end)'
  printf '%s' "$NEW_PLANS" | jq -r '.[] | select(.has_agent == false and .in_state == false) | "- NEW: " + .slug + " | approved+unclaimed, ready to dispatch"'
} >> "$TICK_LOG"
