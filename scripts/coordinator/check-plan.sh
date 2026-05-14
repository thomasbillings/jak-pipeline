#!/usr/bin/env bash
# check-plan.sh — mechanical validator for coordinator-pipeline plan files.
#
# Usage:
#   check-plan.sh <path-to-plan.md>
#
# Exit 0 + stdout {"ok": true, "plan": "...", "findings": []} on a valid plan.
# Exit 1 + stdout JSON with an array of BLOCKER findings otherwise.
#
# All findings are BLOCKER-class (binary pass/fail). The agent's judgment
# rubric handles SHOULD-FIX and NIT.

set -euo pipefail

command -v jq > /dev/null 2>&1 || {
  echo '{"ok":false,"error":"jq is required but not installed"}' >&2
  exit 2
}

PLAN="${1:-}"
if [ -z "$PLAN" ]; then
  echo '{"ok":false,"error":"usage: check-plan.sh <path-to-plan.md>"}' >&2
  exit 2
fi

if [ ! -f "$PLAN" ]; then
  echo "{\"ok\":false,\"error\":\"plan file not found: $PLAN\"}" >&2
  exit 2
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
STATE_FILE="$REPO_ROOT/agents/_state.json"

# Accumulator for findings — each is a JSON object.
FINDINGS="[]"

add_finding () {
  local check="$1"
  local message="$2"
  FINDINGS="$(jq --arg c "$check" --arg m "$message" \
    '. + [{severity:"BLOCKER", check:$c, message:$m}]' <<< "$FINDINGS")"
}

# ---- 1. Filename check ----
basename_plan="$(basename "$PLAN")"
if [[ ! "$basename_plan" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}-[a-z0-9-]+\.md$ ]]; then
  add_finding "filename" "filename must match YYYY-MM-DD-<kebab-slug>.md; got: $basename_plan"
fi

# ---- 2. Frontmatter delimiters ----
FIRST_LINE="$(head -1 "$PLAN")"
if [ "$FIRST_LINE" != "---" ]; then
  add_finding "frontmatter" "first line must be '---' (YAML frontmatter delimiter)"
fi

# Extract frontmatter body (between first and second '---')
FRONTMATTER="$(awk '/^---$/{c++; next} c==1{print} c==2{exit}' "$PLAN")"
if [ -z "$FRONTMATTER" ]; then
  add_finding "frontmatter" "no YAML frontmatter body found between --- delimiters"
  # Nothing more we can check; emit and exit.
  jq -n --arg plan "$PLAN" --argjson findings "$FINDINGS" \
    '{ok: false, plan: $plan, findings: $findings}'
  exit 1
fi

# Helper: extract a top-level scalar field from the frontmatter.
# Strips surrounding single/double quotes via tr (portable across BSD + GNU).
get_scalar () {
  echo "$FRONTMATTER" \
    | sed -nE "s/^$1:[[:space:]]+(.+)[[:space:]]*$/\1/p" \
    | head -1 \
    | tr -d "'\""
}

# ---- 3. Required fields ----
SCHEMA_VERSION="$(get_scalar schema_version)"
TITLE="$(get_scalar title)"
TYPE="$(get_scalar type)"
STATUS="$(get_scalar status)"
PRIORITY="$(get_scalar priority)"
CREATED="$(get_scalar created)"

[ -z "$SCHEMA_VERSION" ] && add_finding "schema_version_missing" "required field 'schema_version' is missing"
[ -z "$TITLE" ]          && add_finding "title_missing"          "required field 'title' is missing"
[ -z "$TYPE" ]           && add_finding "type_missing"           "required field 'type' is missing"
[ -z "$STATUS" ]         && add_finding "status_missing"         "required field 'status' is missing"
[ -z "$PRIORITY" ]       && add_finding "priority_missing"       "required field 'priority' is missing"
[ -z "$CREATED" ]        && add_finding "created_missing"        "required field 'created' is missing"

# ---- 4. schema_version handshake ----
if [ -n "$SCHEMA_VERSION" ] && [ "$SCHEMA_VERSION" != "1" ]; then
  add_finding "schema_version_unsupported" "schema_version '$SCHEMA_VERSION' not supported by this version of check-plan.sh; update the script"
fi

# ---- 5. type / status / priority enums ----
case "$TYPE" in
  feature|fix|infra|chore|"") ;;
  *) add_finding "type_enum" "type must be one of {feature, fix, infra, chore}; got: $TYPE" ;;
esac
case "$STATUS" in
  draft|approved|dispatched|done|paused|abandoned|"") ;;
  *) add_finding "status_enum" "status must be one of {draft, approved, dispatched, done, paused, abandoned}; got: $STATUS" ;;
esac
case "$PRIORITY" in
  low|medium|high|"") ;;
  *) add_finding "priority_enum" "priority must be one of {low, medium, high}; got: $PRIORITY" ;;
esac

# ---- 5.5. optional `ticket:` field — validate format if present (issue #63) ----
# Plans MAY declare a `ticket:` field that dispatch.sh consumes to construct
# `feat/<TICKET>-<slug>` branches. If the value doesn't match the canonical
# <PROJECT>-<N> shape, branch-ticket-check.sh's pre-push hook rejects the
# eventual push and the dev-agent stalls with no obvious cause.
# Validate at plan-review time so the planner fixes it before merge.
TICKET="$(get_scalar ticket)"
if [ -n "$TICKET" ]; then
  if ! printf '%s' "$TICKET" | grep -qE '^[A-Z][A-Z0-9_]*-[0-9]+$'; then
    add_finding "ticket_format_invalid" "ticket: must match <PROJECT-KEY>-<N> (uppercase project key, dash, digits); got: $TICKET"
  fi
fi

# ---- 6. depends_on resolution ----
# Extract slugs from either `[a, b]` inline or `- a` multi-line.
DEPS="$(echo "$FRONTMATTER" | awk '
  /^depends_on:/ {
    line=$0; sub(/^depends_on:[[:space:]]*/, "", line);
    if (line ~ /^\[/) {
      gsub(/[\[\]]/, "", line); split(line, a, ","); for (k in a) { gsub(/^[ \t]+|[ \t]+$/,"",a[k]); if (a[k]) print a[k] };
      next;
    }
    capture=1; next;
  }
  capture && /^[A-Za-z_]+:/ { capture=0 }
  capture && /^[[:space:]]*-[[:space:]]*/ { slug=$0; sub(/^[[:space:]]*-[[:space:]]*/, "", slug); gsub(/[ \t]+$/, "", slug); if (slug) print slug }
')"

while IFS= read -r dep; do
  [ -z "$dep" ] && continue
  # Resolve: either a plan file exists matching *-${dep}.md, OR agents/_state.json has it with status: done.
  resolved=false
  for candidate in "$REPO_ROOT"/plans/[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]-"$dep".md; do
    [ -f "$candidate" ] && resolved=true && break
  done
  if [ "$resolved" = "false" ] && [ -f "$STATE_FILE" ]; then
    if jq -e --arg dep "$dep" '.plans[$dep].status == "done"' "$STATE_FILE" > /dev/null 2>&1; then
      resolved=true
    fi
  fi
  if [ "$resolved" = "false" ]; then
    add_finding "depends_on_resolution" "depends_on references '$dep' — no matching plan file found in plans/ and no done entry in agents/_state.json"
  fi
done <<< "$DEPS"

# ---- 7. Acceptance criteria coverage ----
# Extract criterion ids (a1, a2, ...) from the acceptance_criteria block.
CRIT_IDS="$(echo "$FRONTMATTER" | awk '
  /^acceptance_criteria:/ { capture=1; next }
  capture && /^[A-Za-z_]+:/ { capture=0 }
  capture && /^[[:space:]]*-[[:space:]]*a[0-9]+:/ { line=$0; sub(/^[[:space:]]*-[[:space:]]*/,"", line); sub(/:.*/, "", line); print line }
')"

CRIT_COUNT="$(printf '%s\n' "$CRIT_IDS" | grep -cv '^$' || true)"
if [ "${CRIT_COUNT:-0}" -eq 0 ]; then
  add_finding "acceptance_criteria_empty" "acceptance_criteria must contain at least one '- aN: text' entry; none found"
fi

# Extract covers: lists from e2e_tests (flattened)
E2E_COVERS="$(echo "$FRONTMATTER" | awk '
  /^e2e_tests:/ { capture=1; next }
  capture && /^[A-Za-z_]+:/ && !/^[[:space:]]/ { capture=0 }
  capture && /covers:/ { line=$0; sub(/.*covers:[[:space:]]*/, "", line); gsub(/[\[\]]/, "", line); n=split(line, a, ","); for (k=1;k<=n;k++) { gsub(/[ \t]+/, "", a[k]); if (a[k]) print a[k] } }
')"

# Count manual_verification entries (both `- m1: text` and `- a1: text` patterns, plus
# `- covers: [a1]` explicit mapping when present — any dash-list entry counts as one check).
MANUAL_COUNT="$(echo "$FRONTMATTER" | awk '
  /^manual_verification:/ { capture=1; next }
  capture && /^[A-Za-z_]+:/ && !/^[[:space:]]/ { capture=0 }
  capture && /^[[:space:]]*-[[:space:]]*/ { count++ }
  END { print count+0 }
')"

# Extract explicit criterion ids used IN manual_verification entries (e.g. `- a1: text`
# or `covers: [a1]` style). Gives tighter coverage matching for plans that follow it.
MANUAL_EXPLICIT_IDS="$(echo "$FRONTMATTER" | awk '
  /^manual_verification:/ { capture=1; next }
  capture && /^[A-Za-z_]+:/ && !/^[[:space:]]/ { capture=0 }
  capture && /^[[:space:]]*-[[:space:]]*a[0-9]+:/ { line=$0; sub(/^[[:space:]]*-[[:space:]]*/,"", line); sub(/:.*/, "", line); print line }
  capture && /covers:[[:space:]]*\[/ { line=$0; sub(/.*covers:[[:space:]]*/, "", line); gsub(/[\[\]]/, "", line); n=split(line, a, ","); for (k=1;k<=n;k++) { gsub(/[ \t]+/, "", a[k]); if (a[k]) print a[k] } }
')"

COVERED_IDS="$(printf '%s\n%s\n' "$E2E_COVERS" "$MANUAL_EXPLICIT_IDS" | sort -u | grep -v '^$' || true)"

# Coverage rule per criterion id:
#   1. Covered if the id is in COVERED_IDS (explicit e2e or explicit manual mapping).
#   2. Otherwise, if the total manual_verification entry count >= number of NON-explicitly
#      covered criteria, the remaining criteria are considered positionally covered.
#      This is the lenient fallback for plans that list manual checks without explicit
#      covers: mappings — common in infra/chore plans.

# Compute how many criteria are not explicitly covered.
UNCOVERED_EXPLICIT="$(
  while IFS= read -r cid; do
    [ -z "$cid" ] && continue
    grep -qxF "$cid" <<< "$COVERED_IDS" || echo "$cid"
  done <<< "$CRIT_IDS"
)"
UNCOVERED_COUNT="$(printf '%s\n' "$UNCOVERED_EXPLICIT" | grep -cv '^$' || true)"

# Coverage policy:
#   - feature / fix  → strict: every criterion must be explicitly covered
#     (either e2e_tests[].covers or explicit manual covers: mapping).
#     AND at least one e2e_tests entry must exist — feature plans without
#     any automated test are BLOCKER regardless of manual coverage.
#   - infra / chore  → lenient: manual_verification with ≥1 entry is sufficient
#     to cover any criteria not already covered by e2e_tests.
#
# Rationale: features/fixes benefit from rigorous test-to-criterion mapping
# because the product surface is testable; infra/chore plans often do checks
# spiritually (run this smoke, observe that file) where 1:1 mapping is noise.

# Count e2e_tests entries (dash-list items under e2e_tests:).
E2E_COUNT="$(echo "$FRONTMATTER" | awk '
  /^e2e_tests:/ { capture=1; next }
  capture && /^[A-Za-z_]+:/ && !/^[[:space:]]/ { capture=0 }
  capture && /^[[:space:]]*-[[:space:]]*path:/ { count++ }
  END { print count+0 }
')"

case "$TYPE" in
  feature|fix)
    if [ "${E2E_COUNT:-0}" -eq 0 ]; then
      add_finding "feature_requires_e2e" "type=$TYPE requires at least one e2e_tests entry; manual_verification is not sufficient coverage for feature/fix plans"
    fi
    ;;
esac

if [ "${UNCOVERED_COUNT:-0}" -gt 0 ]; then
  case "$TYPE" in
    infra|chore)
      if [ "${MANUAL_COUNT:-0}" -lt 1 ]; then
        while IFS= read -r cid; do
          [ -z "$cid" ] && continue
          add_finding "coverage_mapping" "acceptance criterion '$cid' has no e2e coverage and manual_verification is empty (infra/chore plans require at least one manual entry as coverage)"
        done <<< "$UNCOVERED_EXPLICIT"
      fi
      ;;
    feature|fix|*)
      while IFS= read -r cid; do
        [ -z "$cid" ] && continue
        add_finding "coverage_mapping" "acceptance criterion '$cid' is not covered by any e2e_tests[].covers entry or explicit manual_verification covers: mapping (required for type=$TYPE)"
      done <<< "$UNCOVERED_EXPLICIT"
      ;;
  esac
fi

# Orphan e2e covers: every covered criterion must exist in CRIT_IDS.
while IFS= read -r covered; do
  [ -z "$covered" ] && continue
  # Only check 'a'-prefixed entries; manual ids (m*) are self-referential.
  [[ "$covered" =~ ^a[0-9]+$ ]] || continue
  if ! grep -qxF "$covered" <<< "$CRIT_IDS"; then
    add_finding "orphan_coverage" "e2e_tests[].covers references '$covered' but no such acceptance criterion exists in this plan"
  fi
done <<< "$E2E_COVERS"

# ---- 8. Emit result ----
FINDING_COUNT="$(jq 'length' <<< "$FINDINGS")"
if [ "$FINDING_COUNT" -eq 0 ]; then
  jq -n --arg plan "$PLAN" '{ok: true, plan: $plan, findings: []}'
  exit 0
else
  jq -n --arg plan "$PLAN" --argjson findings "$FINDINGS" \
    '{ok: false, plan: $plan, findings: $findings}'
  exit 1
fi
