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

# reconcile_state_from_journals
#
# Walks agents/_state.json's .agents map and, for each entry, parses the
# corresponding journal file's frontmatter. Updates status, last_heartbeat,
# checkpoint, and pr_url in _state.json to match the journal.
#
# The journal is the source of truth — dev-agents write to it directly
# and never touch _state.json. Without this reconcile pass, _state.json
# stays frozen at the dispatch-time values and tick.sh's "stuck" detector
# fires false-positives (heartbeat appears never to advance) and merged
# plans stay eligible forever (status never flips to "done"). See #48.
#
# Idempotent — re-running with no journal changes is a no-op.
# Requires: STATE_FILE and state_write defined. Caller cd'd to repo root.
# Requires: python3 (hard dep, same as elsewhere in coordinator-pipeline).
#
# Lock contention (issue #61): builds ONE composite jq expression per agent
# and writes via a single state_write call — instead of up-to-4 calls per
# agent (was: one per field). For N active agents on a busy tick.sh+
# dispatch.sh tick, lock acquisitions drop from 4N to N.
#
# Archived journals (issue #62): searches both agents/ and agents/archive/
# so reconciliation keeps working after a completed plan's journal is
# rotated to the archive directory.
reconcile_state_from_journals () {
  command -v jq >/dev/null 2>&1 || return 0
  command -v python3 >/dev/null 2>&1 || return 0
  [ -f "$STATE_FILE" ] || return 0
  local slug journal key val
  while IFS= read -r slug; do
    [ -z "$slug" ] && continue
    # Search both agents/ (active) and agents/archive/ (completed plans)
    journal="$(ls agents/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-"${slug}".md \
                  agents/archive/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-"${slug}".md \
                  2>/dev/null | head -1)"
    [ -z "$journal" ] && continue
    [ -f "$journal" ] || continue

    # Parse frontmatter; collect into a jq composite expression so we acquire
    # the state lock once per agent (issue #61).
    local jq_expr=""
    local -a jq_args=()
    while IFS=$'\t' read -r key val; do
      [ -z "$key" ] && continue
      [ -z "$val" ] && continue
      # Map each (key, val) into a `--arg <key>_<slug> <val>` + an expression
      # fragment. Arg names are namespaced to avoid jq variable collision when
      # the same key recurs in the loop (shouldn't happen but defensive).
      local argname="v_${key}"
      if [ -z "$jq_expr" ]; then
        jq_expr=".agents[\$slug].${key} = \$${argname}"
      else
        jq_expr="${jq_expr} | .agents[\$slug].${key} = \$${argname}"
      fi
      jq_args+=("--arg" "$argname" "$val")
    done < <(python3 -c '
import sys, re
path = sys.argv[1]
with open(path) as f:
    src = f.read()
m = re.match(r"---\s*\n(.*?)\n---\s*\n", src, re.DOTALL)
if not m:
    sys.exit(0)
for line in m.group(1).splitlines():
    fm = re.match(r"^(status|last_heartbeat|checkpoint|pr_url)\s*:\s*(.+?)\s*$", line.rstrip())
    if not fm:
        continue
    k, v = fm.group(1), fm.group(2)
    if (v.startswith("\"") and v.endswith("\"")) or (v.startswith("'\''") and v.endswith("'\''")):
        v = v[1:-1]
    if v in ("", "null"):
        continue
    print(f"{k}\t{v}")
' "$journal")

    # Single composite write — one lock acquisition for this agent.
    # Use explicit if/fi so the conditional doesn't leak its exit code (1)
    # out of the function when there's nothing to write.
    if [ -n "$jq_expr" ]; then
      state_write "$jq_expr" --arg slug "$slug" "${jq_args[@]}"
    fi
  done < <(jq -r '.agents // {} | keys[]' "$STATE_FILE" 2>/dev/null)
}

# extract_ticket_from_plan <plan-file-path>
#
# Echoes the `ticket:` value from the plan's YAML frontmatter, or empty if
# absent. Used by dispatch.sh to construct the branch name as
# `feat/<TICKET>-<slug>` so it satisfies jak-pipeline's branch-ticket-check
# regex. Without a ticket field, dispatch falls back to `feat/<slug>` (legacy
# behavior, fine for installs that don't have branch-ticket-check enabled).
#
# Tolerant of quoted ("S20-4"), unquoted (S20-4), and trailing-whitespace
# values. Only the FIRST frontmatter block is scanned (between the first two
# `---` lines).
extract_ticket_from_plan () {
  local plan_file="${1:-}"
  [ -f "$plan_file" ] || { echo ""; return; }
  awk '
    BEGIN { in_frontmatter = 0; seen_marker = 0 }
    /^---[[:space:]]*$/ {
      seen_marker++
      if (seen_marker == 1) { in_frontmatter = 1; next }
      if (seen_marker == 2) { exit }
    }
    in_frontmatter && /^ticket:[[:space:]]/ {
      sub(/^ticket:[[:space:]]*/, "")
      gsub(/^["\x27]/, "")
      gsub(/["\x27][[:space:]]*$/, "")
      gsub(/[[:space:]]+$/, "")
      print
      exit
    }
  ' "$plan_file"
}

# extract_ticket_from_branch <branch-name>
#
# Echoes the ticket key from a branch name of the form `<prefix>/<TICKET>-<slug>`,
# or empty if the branch doesn't carry a ticket. Used by the dev-agent to build
# PR titles like `<TICKET>: <type>: <description>` for human discoverability;
# Jira-GitHub auto-linking already works via the branch name alone.
#
# Project key shape — Atlassian-compliant: uppercase letter followed by
# uppercase letters or digits (NO underscores; Atlassian rejects them in
# project keys). Aligned with tick-extension.sh's BRANCH_RE and
# check-plan.sh's step 5.5 validation regex — see issue #67. If you change
# the shape here, update the other two AND the test fixtures.
#
# Accepted prefixes mirror `branch-ticket-check.sh`:
# plan, feat, fix, chore, design, docs, test.
#
# Examples:
#   feat/SCRUM-1-add-foo         → SCRUM-1
#   plan/GH-7-something          → GH-7
#   chore/SCRUM-42-bump-deps     → SCRUM-42
#   feat/S20-4-add-foo           → S20-4   (digit in project key — Atlassian allows)
#   feat/FOO_BAR-12-baz          → ""      (underscore — Atlassian rejects)
#   feat/no-ticket-slug-here     → ""      (legacy fallback path)
#   main                         → ""
extract_ticket_from_branch () {
  local branch="${1:-}"
  printf '%s' "$branch" | sed -nE 's,^(plan|feat|fix|chore|design|docs|test)/([A-Z][A-Z0-9]*-[0-9]+)-.*,\2,p'
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
