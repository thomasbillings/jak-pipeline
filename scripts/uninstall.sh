#!/usr/bin/env bash
set -euo pipefail

# uninstall.sh — remove the jak-pipeline skill from a target project.
#
# Reverses install.sh. Idempotent: skip missing files; never error on
# already-removed artefacts. NEVER touches user-generated content under
# <downstream>/agents/ (the label-log JSONL and Jira retry queue are
# audit data — operators decide separately whether to archive them).
#
# Env:
#   JAK_DOWNSTREAM_ROOT or DOWNSTREAM_ROOT — target project root (default $PWD)
#   JAK_UNINSTALL_DRY_RUN=1 — print what would be removed; do not delete
#   JAK_UNINSTALL_QUIET=1 — suppress per-file output (errors still printed)

DOWNSTREAM_ROOT="${JAK_DOWNSTREAM_ROOT:-${DOWNSTREAM_ROOT:-$PWD}}"
DRY_RUN="${JAK_UNINSTALL_DRY_RUN:-0}"
QUIET="${JAK_UNINSTALL_QUIET:-0}"

_log() {
  if [[ "$QUIET" != "1" ]]; then
    echo "$@"
  fi
}

_rm_if_exists() {
  local path="$1"
  local label="${2:-$path}"
  if [ -e "$path" ] || [ -L "$path" ]; then
    if [[ "$DRY_RUN" == "1" ]]; then
      _log "[dry-run] would remove $label"
    else
      rm -rf "$path"
      _log "  removed $label"
    fi
  fi
}

# Remove a sentinel-bounded block from a file: from the sentinel line back to
# (and including) any preceding blank line, through to the next blank line or
# EOF. Used for install-time appends.
_remove_sentinel_block() {
  local file="$1"
  local sentinel="$2"
  local label="${3:-$file}"
  if [ ! -f "$file" ]; then
    return 0
  fi
  if ! grep -qF "$sentinel" "$file"; then
    return 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    _log "[dry-run] would strip sentinel block from $label (sentinel: $sentinel)"
    return 0
  fi
  local tmp
  tmp=$(mktemp)
  python3 - "$file" "$sentinel" "$tmp" <<'PYEOF'
import sys, pathlib
src, sentinel, dst = sys.argv[1], sys.argv[2], sys.argv[3]
text = pathlib.Path(src).read_text()
idx = text.find(sentinel)
if idx == -1:
    pathlib.Path(dst).write_text(text)
else:
    # Start of the line containing the sentinel
    line_start = text.rfind('\n', 0, idx) + 1
    # Walk back one preceding blank line if present (install.sh adds one)
    if line_start >= 2 and text[line_start-2] == '\n':
        line_start -= 1
    pathlib.Path(dst).write_text(text[:line_start])
PYEOF
  mv "$tmp" "$file"
  _log "  stripped sentinel block from $label"
}

# Remove a single matching line (idempotent — line may be absent).
_remove_line() {
  local file="$1"
  local pattern="$2"
  if [ ! -f "$file" ]; then
    return 0
  fi
  if ! grep -qE "$pattern" "$file"; then
    return 0
  fi
  if [[ "$DRY_RUN" == "1" ]]; then
    _log "[dry-run] would remove line matching $pattern from $file"
    return 0
  fi
  local tmp
  tmp=$(mktemp)
  grep -vE "$pattern" "$file" > "$tmp" || true
  mv "$tmp" "$file"
  _log "  removed line matching $pattern from ${file##*/}"
}

_log "[uninstall] Removing jak-pipeline from $DOWNSTREAM_ROOT"
if [[ "$DRY_RUN" == "1" ]]; then
  _log "[uninstall] DRY RUN — no files will be modified"
fi

# -----------------------------------------------------------------------------
# Plan 0 — Coordinator pipeline scaffolding
# -----------------------------------------------------------------------------
_log "[Plan 0] Removing coordinator-pipeline scaffolding"

# Agent files
_rm_if_exists "$DOWNSTREAM_ROOT/.claude/agents/planner.md" ".claude/agents/planner.md"
_rm_if_exists "$DOWNSTREAM_ROOT/.claude/agents/plan-reviewer.md" ".claude/agents/plan-reviewer.md"
_rm_if_exists "$DOWNSTREAM_ROOT/.claude/agents/dev-agent.md" ".claude/agents/dev-agent.md"
_rm_if_exists "$DOWNSTREAM_ROOT/.claude/commands/coordinator-tick.md" ".claude/commands/coordinator-tick.md"

# Coordinator scripts
for s in tick.sh dispatch.sh lib.sh check-plan.sh; do
  _rm_if_exists "$DOWNSTREAM_ROOT/scripts/coordinator/$s" "scripts/coordinator/$s"
done
if [ -d "$DOWNSTREAM_ROOT/scripts/coordinator" ]; then
  rmdir "$DOWNSTREAM_ROOT/scripts/coordinator" 2>/dev/null || true
fi

# Plan template (user-written plans under plans/ are PRESERVED)
_rm_if_exists "$DOWNSTREAM_ROOT/plans/_template.md" "plans/_template.md"

# Pipeline config
_rm_if_exists "$DOWNSTREAM_ROOT/.coordinator-pipeline.json" ".coordinator-pipeline.json"

# Strip the entire jak-pipeline gitignore block via the leading marker comment
# (the template starts with "# coordinator pipeline — agent state…").
GITIGNORE="$DOWNSTREAM_ROOT/.gitignore"
GITIGNORE_MARKER="# coordinator pipeline — agent state"
if [ -f "$GITIGNORE" ] && grep -qF "$GITIGNORE_MARKER" "$GITIGNORE"; then
  if [[ "$DRY_RUN" == "1" ]]; then
    _log "[dry-run] would strip the coordinator/jak-pipeline gitignore block from .gitignore"
  else
    tmp=$(mktemp)
    python3 - "$GITIGNORE" "$tmp" <<'PYEOF'
import sys, pathlib
src, dst = sys.argv[1], sys.argv[2]
text = pathlib.Path(src).read_text()
marker = "# coordinator pipeline — agent state"
idx = text.find(marker)
if idx == -1:
    pathlib.Path(dst).write_text(text)
else:
    # Walk back over a preceding blank line (install adds one)
    line_start = text.rfind('\n', 0, idx) + 1
    if line_start >= 2 and text[line_start-2] == '\n':
        line_start -= 1
    # Strip everything from marker to EOF (the install template was appended last)
    pathlib.Path(dst).write_text(text[:line_start])
PYEOF
    mv "$tmp" "$GITIGNORE"
    _log "  stripped coordinator/jak-pipeline block from .gitignore"
  fi
fi

# -----------------------------------------------------------------------------
# Plan 1 — MCP server
# -----------------------------------------------------------------------------
_log "[Plan 1] Removing MCP server install"
_rm_if_exists "$DOWNSTREAM_ROOT/.claude/mcp/mergify" ".claude/mcp/mergify/"

# Strip 'mergify' from .mcp.json; remove file if no servers left
MCP_JSON="$DOWNSTREAM_ROOT/.mcp.json"
if [ -f "$MCP_JSON" ]; then
  if [[ "$DRY_RUN" == "1" ]]; then
    _log "[dry-run] would deregister 'mergify' MCP server from .mcp.json"
  else
    python3 - "$MCP_JSON" <<'PYEOF'
import json, pathlib, sys
p = pathlib.Path(sys.argv[1])
try:
    data = json.loads(p.read_text())
except Exception:
    sys.exit(0)
servers = data.get('mcpServers') or {}
if 'mergify' in servers:
    del servers['mergify']
if servers:
    data['mcpServers'] = servers
    p.write_text(json.dumps(data, indent=2) + '\n')
else:
    p.unlink()
PYEOF
    _log "  deregistered 'mergify' from .mcp.json (file removed if empty)"
  fi
fi

# Remove pre-commit hook installation (both .husky/ and .git/hooks/)
_remove_sentinel_block "$DOWNSTREAM_ROOT/.husky/pre-commit" "# jak-pipeline pre-commit token-prefix scan" ".husky/pre-commit"
_remove_sentinel_block "$DOWNSTREAM_ROOT/.git/hooks/pre-commit" "# jak-pipeline pre-commit token-prefix scan" ".git/hooks/pre-commit"
_rm_if_exists "$DOWNSTREAM_ROOT/scripts/hooks/pre-commit" "scripts/hooks/pre-commit (jak-pipeline copy)"

# -----------------------------------------------------------------------------
# Plan 2 — Mergify config + label trust boundary
# -----------------------------------------------------------------------------
_log "[Plan 2] Removing Mergify config + label trust boundary"
_rm_if_exists "$DOWNSTREAM_ROOT/.mergify.yml" ".mergify.yml"

# Strip the pr-reviewer overlay (sentinel-bounded) — preserves user content
_remove_sentinel_block \
  "$DOWNSTREAM_ROOT/.claude/agents/pr-reviewer.md" \
  "<!-- jak-pipeline:pr-reviewer-label-gate v1 -->" \
  ".claude/agents/pr-reviewer.md (overlay)"

# Remove the three label-trust scripts
for script in label-gate-decide.sh label-log-append.sh branch-ticket-check.sh; do
  _rm_if_exists "$DOWNSTREAM_ROOT/.claude/jak-pipeline/scripts/$script" ".claude/jak-pipeline/scripts/$script"
done
# Remove the jak-pipeline/scripts/ dir if empty
if [ -d "$DOWNSTREAM_ROOT/.claude/jak-pipeline/scripts" ]; then
  rmdir "$DOWNSTREAM_ROOT/.claude/jak-pipeline/scripts" 2>/dev/null || true
fi

# Remove pre-push hook installation
_remove_sentinel_block "$DOWNSTREAM_ROOT/.husky/pre-push" "# jak-pipeline branch-ticket-check" ".husky/pre-push"
_remove_sentinel_block "$DOWNSTREAM_ROOT/.git/hooks/pre-push" "# jak-pipeline branch-ticket-check" ".git/hooks/pre-push"

# agents/_label-log.jsonl gitignore line is part of the Plan 0 gitignore block
# (templates/gitignore-additions.txt) — stripped wholesale during Plan 0
# uninstall above; no per-line surgery needed here.

# -----------------------------------------------------------------------------
# Plan 3 — Jira integration
# -----------------------------------------------------------------------------
_log "[Plan 3] Removing Jira integration"
_rm_if_exists "$DOWNSTREAM_ROOT/scripts/jak-pipeline/doctor.sh" "scripts/jak-pipeline/doctor.sh"
for script in transition.sh provision-board.sh drain-retry-queue.sh tick-extension.sh; do
  _rm_if_exists "$DOWNSTREAM_ROOT/scripts/jak-pipeline/jira/$script" "scripts/jak-pipeline/jira/$script"
done
_rm_if_exists "$DOWNSTREAM_ROOT/scripts/jak-pipeline/jira/lib/kanban-order.sh" "scripts/jak-pipeline/jira/lib/kanban-order.sh"

if [ -d "$DOWNSTREAM_ROOT/scripts/jak-pipeline/jira/lib" ]; then
  rmdir "$DOWNSTREAM_ROOT/scripts/jak-pipeline/jira/lib" 2>/dev/null || true
fi
if [ -d "$DOWNSTREAM_ROOT/scripts/jak-pipeline/jira" ]; then
  rmdir "$DOWNSTREAM_ROOT/scripts/jak-pipeline/jira" 2>/dev/null || true
fi

# Remove the tick.sh source line block (install appends a 3-line block plus
# a preceding blank line).
TICK_SH="$DOWNSTREAM_ROOT/scripts/coordinator/tick.sh"
if [ -f "$TICK_SH" ] && grep -qF "jak_pipeline_jira_tick_pass" "$TICK_SH"; then
  if [[ "$DRY_RUN" == "1" ]]; then
    _log "[dry-run] would remove jak_pipeline_jira_tick_pass block from tick.sh"
  else
    tmp=$(mktemp)
    python3 - "$TICK_SH" "$tmp" <<'PYEOF'
import sys, pathlib, re
src, dst = sys.argv[1], sys.argv[2]
text = pathlib.Path(src).read_text()
# install.sh appends:
#   <blank>
#   # jak-pipeline: Jira tick pass
#   . "$(dirname "${BASH_SOURCE[0]}")/../jak-pipeline/jira/tick-extension.sh"
#   jak_pipeline_jira_tick_pass
pattern = re.compile(
    r'\n# jak-pipeline: Jira tick pass\n'
    r'\. "\$\(dirname "\$\{BASH_SOURCE\[0\]\}"\)/\.\./jak-pipeline/jira/tick-extension\.sh"\n'
    r'jak_pipeline_jira_tick_pass\n',
    re.MULTILINE,
)
new = pattern.sub('', text)
pathlib.Path(dst).write_text(new)
PYEOF
    mv "$tmp" "$TICK_SH"
    _log "  removed jak_pipeline_jira_tick_pass block from scripts/coordinator/tick.sh"
  fi
fi

# Remove .claude/jira/.env (installed by install.sh; rmdir parent if empty).
_rm_if_exists "$DOWNSTREAM_ROOT/.claude/jira/.env" ".claude/jira/.env (contains Jira credentials)"
if [ -d "$DOWNSTREAM_ROOT/.claude/jira" ]; then
  rmdir "$DOWNSTREAM_ROOT/.claude/jira" 2>/dev/null || true
fi

# -----------------------------------------------------------------------------
# Plan 4 — UAT + Storybook preview
# -----------------------------------------------------------------------------
_log "[Plan 4] Removing UAT + Storybook scaffolding"
_rm_if_exists "$DOWNSTREAM_ROOT/.claude/jak-pipeline/config.env" ".claude/jak-pipeline/config.env"
_rm_if_exists "$DOWNSTREAM_ROOT/docker/docker-compose.local-uat.yml" "docker/docker-compose.local-uat.yml"
_rm_if_exists "$DOWNSTREAM_ROOT/.github/workflows/storybook-preview.yml" ".github/workflows/storybook-preview.yml"

for script in run.sh local-docker-start.sh local-docker-stop.sh local-docker-accept.sh local-docker-reject.sh; do
  _rm_if_exists "$DOWNSTREAM_ROOT/scripts/jak-pipeline/uat/$script" "scripts/jak-pipeline/uat/$script"
done
if [ -d "$DOWNSTREAM_ROOT/scripts/jak-pipeline/uat" ]; then
  rmdir "$DOWNSTREAM_ROOT/scripts/jak-pipeline/uat" 2>/dev/null || true
fi
if [ -d "$DOWNSTREAM_ROOT/scripts/jak-pipeline" ]; then
  rmdir "$DOWNSTREAM_ROOT/scripts/jak-pipeline" 2>/dev/null || true
fi

# Clean up empty parent dirs
if [ -d "$DOWNSTREAM_ROOT/.claude/jak-pipeline" ]; then
  rmdir "$DOWNSTREAM_ROOT/.claude/jak-pipeline" 2>/dev/null || true
fi
if [ -d "$DOWNSTREAM_ROOT/.claude/mcp" ]; then
  rmdir "$DOWNSTREAM_ROOT/.claude/mcp" 2>/dev/null || true
fi
if [ -d "$DOWNSTREAM_ROOT/.github/workflows" ]; then
  rmdir "$DOWNSTREAM_ROOT/.github/workflows" 2>/dev/null || true
fi
if [ -d "$DOWNSTREAM_ROOT/.github" ]; then
  rmdir "$DOWNSTREAM_ROOT/.github" 2>/dev/null || true
fi

# -----------------------------------------------------------------------------
# Preserve user-generated content under agents/
# -----------------------------------------------------------------------------
_log ""
_log "[uninstall] ✓ Removed all installed jak-pipeline files."
_log "[uninstall]   Preserved: agents/ (audit data — label log, Jira retry queue)"
_log "[uninstall]   To re-install: bash <jak-pipeline>/scripts/install.sh from this directory."

exit 0
