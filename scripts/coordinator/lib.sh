#!/usr/bin/env bash
# coordinator-pipeline — shared helpers for tick.sh and dispatch.sh.
#
# Source this file early: `. "$(dirname "$0")/lib.sh"`.

: "${STATE_FILE:=agents/_state.json}"
: "${STATE_LOCK:=agents/_state.json.lock}"
: "${PIPELINE_CONFIG:=.coordinator-pipeline.json}"
: "${PLAN_CACHE_DIR:=.plan-cache}"

# load_pipeline_config
#
# Reads .coordinator-pipeline.json from the repo root (if present) and
# exports PLAN_REPO + PROJECT into the calling shell. When the file is
# absent, both vars are exported empty — callers treat empty as
# "legacy mode" and fall back to local plans/.
#
# Schema (v1, no schema_version key yet):
#   { "plan_repo": "<owner>/<repo>", "project": "<downstream-project-name>" }
load_pipeline_config () {
  PLAN_REPO=""
  PROJECT=""
  if [ -f "$PIPELINE_CONFIG" ]; then
    PLAN_REPO="$(jq -r '.plan_repo // empty' "$PIPELINE_CONFIG" 2>/dev/null || echo "")"
    PROJECT="$(jq -r '.project // empty' "$PIPELINE_CONFIG" 2>/dev/null || echo "")"
    if [ -z "$PLAN_REPO" ] || [ -z "$PROJECT" ]; then
      echo "coordinator-pipeline: $PIPELINE_CONFIG present but missing required keys (plan_repo, project) — falling back to legacy local plans/" >&2
      PLAN_REPO=""
      PROJECT=""
    fi
  fi
  export PLAN_REPO PROJECT
}

# state_write <jq_expr> [jq args...]
#
# Read-modify-write `_state.json` atomically, under an exclusive flock
# so concurrent `tick.sh` + `dispatch.sh` invocations don't race.
# Falls back to an unlocked write with a warning if flock is missing.
state_write () {
  local jq_expr="$1"
  shift
  local tmp
  tmp="$(mktemp)"
  if command -v flock > /dev/null 2>&1; then
    (
      flock -x 9
      jq "$@" "$jq_expr" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
    ) 9>"$STATE_LOCK"
  else
    echo "warning: flock not found; state writes are unlocked" >&2
    jq "$@" "$jq_expr" "$STATE_FILE" > "$tmp" && mv "$tmp" "$STATE_FILE"
  fi
}
