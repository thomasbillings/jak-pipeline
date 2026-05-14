#!/usr/bin/env bash
set -euo pipefail

# migrate-from-coordinator.sh — one-time migration of a downstream from the
# pre-#70 "coordinator" layout to the current "scrum-master" layout.
#
# Usage:
#   migrate-from-coordinator.sh [--dry-run] [--no-git-mv]
#
# Run from the downstream project root or set JAK_DOWNSTREAM_ROOT. Idempotent —
# if there are no pre-rename artifacts present, exits 0 without changes.
#
# What it does:
#   1. Renames directories + files:
#        scripts/coordinator/                  → scripts/scrum-master/
#        .coordinator-pipeline.json            → .scrum-master.json
#        .claude/commands/coordinator-tick.md  → .claude/commands/scrum-master.md
#   2. Rewrites textual references in user-owned customisable files:
#        .claude/agents/{planner,plan-reviewer,dev-agent,pr-reviewer}.md
#        .claude/mcp/mergify/.env  (MERGIFY_MCP_ROLE=coordinator → scrum-master)
#        .mergify.yml, .scrum-master.json,
#        docker/docker-compose.local-uat.yml, .claude/commands/scrum-master.md
#      Substitutions (in order, case-sensitive, word-boundary):
#        coordinator-tick      → scrum-master
#        coordinator-pipeline  → scrum-master
#        \bcoordinator\b       → scrum-master  (preserves "coordinate" / "coordination")
#
# What it does NOT do:
#   - Rewrite skill-owned scripts under scripts/scrum-master/ (post-rename) or
#     scripts/jak-pipeline/. Run install.sh + update.sh afterwards to pick up
#     the upstream copies of those.
#   - Migrate or touch .env credentials beyond the MERGIFY_MCP_ROLE value.

DOWNSTREAM_ROOT="${JAK_DOWNSTREAM_ROOT:-${DOWNSTREAM_ROOT:-$PWD}}"
DRY_RUN=0
USE_GIT_MV=1

while [[ $# -gt 0 ]]; do
  case "$1" in
    --dry-run)    DRY_RUN=1; shift ;;
    --no-git-mv)  USE_GIT_MV=0; shift ;;
    --help|-h)
      sed -n '4,33p' "$0" | sed 's/^# \?//'
      exit 0
      ;;
    *) echo "ERROR: unknown flag '$1' (try --help)" >&2; exit 1 ;;
  esac
done

if [ ! -d "$DOWNSTREAM_ROOT" ]; then
  echo "ERROR: DOWNSTREAM_ROOT=$DOWNSTREAM_ROOT is not a directory" >&2
  exit 1
fi
cd "$DOWNSTREAM_ROOT"

# --- Detect already-migrated ------------------------------------------------
has_old=0
[ -d "scripts/coordinator" ] && has_old=1
[ -f ".coordinator-pipeline.json" ] && has_old=1
[ -f ".claude/commands/coordinator-tick.md" ] && has_old=1
if [ "$has_old" = "0" ]; then
  echo "[migrate] No pre-rename artifacts found — already migrated. (No changes.)"
  exit 0
fi

echo "[migrate] downstream:  $DOWNSTREAM_ROOT"
echo "[migrate] dry-run:     $DRY_RUN"
echo "[migrate] use-git-mv:  $USE_GIT_MV"
echo

# --- Build plan ------------------------------------------------------------
# Renames (one src+dst per row, space-separated)
RENAME_PLAN=()
[ -d "scripts/coordinator" ] && RENAME_PLAN+=("dir scripts/coordinator scripts/scrum-master")
[ -f ".coordinator-pipeline.json" ] && RENAME_PLAN+=("file .coordinator-pipeline.json .scrum-master.json")
[ -f ".claude/commands/coordinator-tick.md" ] && RENAME_PLAN+=("file .claude/commands/coordinator-tick.md .claude/commands/scrum-master.md")

# Content rewrites — restrict to user-owned customisable files. Post-rename
# paths are listed (i.e. we treat post-rename target as the rewrite target).
REWRITE_CANDIDATES=(
  ".claude/agents/planner.md"
  ".claude/agents/plan-reviewer.md"
  ".claude/agents/dev-agent.md"
  ".claude/agents/pr-reviewer.md"
  ".claude/mcp/mergify/.env"
  ".mergify.yml"
  ".scrum-master.json"
  "docker/docker-compose.local-uat.yml"
  ".claude/commands/scrum-master.md"
)

# --- Print plan ------------------------------------------------------------
echo "Plan:"
for r in "${RENAME_PLAN[@]}"; do
  read -r kind src dst <<< "$r"
  case "$kind" in
    dir)  echo "  [RENAME-DIR]  $src/ → $dst/" ;;
    file) echo "  [RENAME-FILE] $src → $dst" ;;
  esac
done
# For rewrite preview, look at the *current* paths (pre-rename for the json,
# post-rename for everything else) so we don't lie about what we'll touch.
PRE_RENAME_CHECKLIST=(
  ".claude/agents/planner.md"
  ".claude/agents/plan-reviewer.md"
  ".claude/agents/dev-agent.md"
  ".claude/agents/pr-reviewer.md"
  ".claude/mcp/mergify/.env"
  ".mergify.yml"
  ".coordinator-pipeline.json"
  "docker/docker-compose.local-uat.yml"
  ".claude/commands/coordinator-tick.md"
)
for f in "${PRE_RENAME_CHECKLIST[@]}"; do
  [ -f "$f" ] || continue
  if grep -q "coordinator" "$f" 2>/dev/null; then
    echo "  [REWRITE]     $f"
  fi
done

echo
if [ "$DRY_RUN" = "1" ]; then
  echo "[migrate] DRY-RUN — no changes applied. Re-run without --dry-run to apply."
  exit 0
fi

# --- Apply renames ---------------------------------------------------------
in_git_repo=0
if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  in_git_repo=1
fi

do_mv() {
  local src="$1" dst="$2"
  mkdir -p "$(dirname "$dst")"
  if [ "$USE_GIT_MV" = "1" ] && [ "$in_git_repo" = "1" ]; then
    git mv "$src" "$dst"
  else
    mv "$src" "$dst"
  fi
}

for r in "${RENAME_PLAN[@]}"; do
  read -r kind src dst <<< "$r"
  echo "  moving: $src → $dst"
  do_mv "$src" "$dst"
done

# --- Apply content rewrites ------------------------------------------------
# Collect files that exist post-rename and contain "coordinator"
REWRITE_LIST=()
for f in "${REWRITE_CANDIDATES[@]}"; do
  if [ -f "$f" ] && grep -q "coordinator" "$f" 2>/dev/null; then
    REWRITE_LIST+=("$f")
  fi
done

if [ "${#REWRITE_LIST[@]}" -gt 0 ]; then
  python3 - "${REWRITE_LIST[@]}" <<'PY'
import sys, re, os
SUBS = [
    (re.compile(r'\bcoordinator-tick\b'), 'scrum-master'),
    (re.compile(r'\bcoordinator-pipeline\b'), 'scrum-master'),
    (re.compile(r'\bcoordinator\b'), 'scrum-master'),
]
for path in sys.argv[1:]:
    if not os.path.isfile(path):
        continue
    with open(path) as f:
        text = f.read()
    new = text
    for rx, repl in SUBS:
        new = rx.sub(repl, new)
    if new != text:
        with open(path, 'w') as f:
            f.write(new)
        print(f"  rewrote: {path}")
PY
fi

echo
echo "[migrate] Migration complete. Next steps:"
echo "  1. bash \$JAK_SKILL_ROOT/scripts/install.sh"
echo "     # installs the new scrum-master binary (no-op for files already present)"
echo "  2. bash \$JAK_SKILL_ROOT/scripts/update.sh"
echo "     # refreshes skill-owned scripts that drifted from upstream + bootstraps"
echo "     # .claude/jak-pipeline/install-manifest.json"
echo "  3. Review the changes ('git diff' if downstream is a git repo)."
