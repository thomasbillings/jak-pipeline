#!/usr/bin/env bash
set -euo pipefail

# install.sh — install the jak-pipeline skill into a target project.
#
# Run from inside the target project's root (or set JAK_DOWNSTREAM_ROOT).
# JAK_SKILL_ROOT — path to the jak-pipeline skill repo (defaults to this script's parent).

JAK_SKILL_ROOT="${JAK_SKILL_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DOWNSTREAM_ROOT="${JAK_DOWNSTREAM_ROOT:-${DOWNSTREAM_ROOT:-$PWD}}"

# ---------------------------------------------------------------------------
# TODO Plan 1 — wire up Mergify MCP server (mcp/mergify/) into target's
#   .claude/mcp/ and seed the redaction wrapper + env-file template.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# Plan 2 — Mergify config + label trust boundary + branch-ticket binding
# ---------------------------------------------------------------------------
PLAN2_ERRORS=()

# (i) Copy .mergify.yml template
MERGIFY_TMPL="${JAK_SKILL_ROOT}/templates/.mergify.yml.tmpl"
MERGIFY_DEST="${DOWNSTREAM_ROOT}/.mergify.yml"
if [ ! -f "$MERGIFY_TMPL" ]; then
  PLAN2_ERRORS+=("MISSING: $MERGIFY_TMPL — skill installation may be incomplete")
elif [ -f "$MERGIFY_DEST" ]; then
  echo "[Plan 2] ✓ .mergify.yml already present (idempotent — not overwritten)"
else
  cp "$MERGIFY_TMPL" "$MERGIFY_DEST"
  echo "[Plan 2] ✓ Installed .mergify.yml"
fi

# (ii) Append pr-reviewer label-gate overlay (idempotent via sentinel comment)
OVERLAY_SRC="${JAK_SKILL_ROOT}/templates/agents/pr-reviewer-label-gate.md"
PR_REVIEWER_DEST="${DOWNSTREAM_ROOT}/.claude/agents/pr-reviewer.md"
SENTINEL="<!-- jak-pipeline:pr-reviewer-label-gate v1 -->"

if [ ! -f "$OVERLAY_SRC" ]; then
  PLAN2_ERRORS+=("MISSING: $OVERLAY_SRC")
elif [ ! -f "$PR_REVIEWER_DEST" ]; then
  echo "[Plan 2] SKIP overlay — $PR_REVIEWER_DEST does not exist (create it first)"
else
  if grep -qF "$SENTINEL" "$PR_REVIEWER_DEST" 2>/dev/null; then
    echo "[Plan 2] ✓ pr-reviewer overlay already present (idempotent)"
  else
    SCRIPTS_DEST="${DOWNSTREAM_ROOT}/.claude/jak-pipeline/scripts"
    mkdir -p "$SCRIPTS_DEST"
    for script in label-gate-decide.sh label-log-append.sh branch-ticket-check.sh; do
      src="${JAK_SKILL_ROOT}/scripts/${script}"
      if [ -f "$src" ]; then
        cp "$src" "${SCRIPTS_DEST}/${script}"
        chmod +x "${SCRIPTS_DEST}/${script}"
      else
        PLAN2_ERRORS+=("MISSING script: $src")
      fi
    done
    if [ ${#PLAN2_ERRORS[@]} -eq 0 ]; then
      echo "" >> "$PR_REVIEWER_DEST"
      cat "$OVERLAY_SRC" >> "$PR_REVIEWER_DEST"
      echo "[Plan 2] ✓ Appended pr-reviewer label-gate overlay"
    fi
  fi
fi

# (iii) Install scripts to .claude/jak-pipeline/scripts/
SCRIPTS_DEST="${DOWNSTREAM_ROOT}/.claude/jak-pipeline/scripts"
if [ -d "$SCRIPTS_DEST" ]; then
  echo "[Plan 2] ✓ Scripts already installed at $SCRIPTS_DEST"
else
  mkdir -p "$SCRIPTS_DEST"
  for script in label-gate-decide.sh label-log-append.sh branch-ticket-check.sh; do
    src="${JAK_SKILL_ROOT}/scripts/${script}"
    if [ -f "$src" ]; then
      cp "$src" "${SCRIPTS_DEST}/${script}"
      chmod +x "${SCRIPTS_DEST}/${script}"
    else
      PLAN2_ERRORS+=("MISSING script: $src")
    fi
  done
  echo "[Plan 2] ✓ Installed scripts to $SCRIPTS_DEST"
fi

# (iv) Install branch-ticket-check.sh as pre-push hook (idempotent via sentinel)
HOOK_SENTINEL="# jak-pipeline branch-ticket-check"
BRANCH_CHECK="${SCRIPTS_DEST}/branch-ticket-check.sh"

if [ -d "${DOWNSTREAM_ROOT}/.husky" ]; then
  HOOK_FILE="${DOWNSTREAM_ROOT}/.husky/pre-push"
  if [ ! -f "$HOOK_FILE" ]; then
    echo "#!/usr/bin/env sh" > "$HOOK_FILE"
    echo ". \"\$(dirname -- \"\$0\")/_/husky.sh\"" >> "$HOOK_FILE"
  fi
  if grep -qF "$HOOK_SENTINEL" "$HOOK_FILE" 2>/dev/null; then
    echo "[Plan 2] ✓ pre-push hook already has branch-ticket-check (idempotent)"
  else
    printf '\n%s\n.claude/jak-pipeline/scripts/branch-ticket-check.sh "$(git rev-parse --abbrev-ref HEAD)"\n' \
      "$HOOK_SENTINEL" >> "$HOOK_FILE"
    chmod +x "$HOOK_FILE"
    echo "[Plan 2] ✓ Added branch-ticket-check to .husky/pre-push"
  fi
else
  HOOK_FILE="${DOWNSTREAM_ROOT}/.git/hooks/pre-push"
  if [ ! -f "$HOOK_FILE" ]; then
    echo "#!/usr/bin/env bash" > "$HOOK_FILE"
  fi
  if grep -qF "$HOOK_SENTINEL" "$HOOK_FILE" 2>/dev/null; then
    echo "[Plan 2] ✓ pre-push hook already has branch-ticket-check (idempotent)"
  else
    printf '\n%s\n.claude/jak-pipeline/scripts/branch-ticket-check.sh "$(git rev-parse --abbrev-ref HEAD)"\n' \
      "$HOOK_SENTINEL" >> "$HOOK_FILE"
    chmod +x "$HOOK_FILE"
    echo "[Plan 2] ✓ Added branch-ticket-check to .git/hooks/pre-push"
  fi
fi

# (v) Append agents/_label-log.jsonl to .gitignore (idempotent)
GITIGNORE="${DOWNSTREAM_ROOT}/.gitignore"
GITIGNORE_ENTRY="agents/_label-log.jsonl"
if [ ! -f "$GITIGNORE" ]; then
  echo "$GITIGNORE_ENTRY" > "$GITIGNORE"
  echo "[Plan 2] ✓ Created .gitignore with $GITIGNORE_ENTRY"
elif grep -qF "$GITIGNORE_ENTRY" "$GITIGNORE" 2>/dev/null; then
  echo "[Plan 2] ✓ .gitignore already contains $GITIGNORE_ENTRY (idempotent)"
else
  echo "$GITIGNORE_ENTRY" >> "$GITIGNORE"
  echo "[Plan 2] ✓ Added $GITIGNORE_ENTRY to .gitignore"
fi

if [ ${#PLAN2_ERRORS[@]} -gt 0 ]; then
  echo "[Plan 2] ✗ Install errors:" >&2
  for err in "${PLAN2_ERRORS[@]}"; do
    echo "  - $err" >&2
  done
  exit 1
fi

echo "[Plan 2] ✓ Plan 2 install complete"

# ---------------------------------------------------------------------------
# Plan 3 — Jira integration: transition helper, drift reconciliation,
#   retry queue, tick.sh registration.
# ---------------------------------------------------------------------------
PLAN3_ERRORS=()

# (i) Copy Jira scripts to <downstream>/scripts/jak-pipeline/jira/
JIRA_SRC="${JAK_SKILL_ROOT}/scripts/jira"
JIRA_DEST="${DOWNSTREAM_ROOT}/scripts/jak-pipeline/jira"
mkdir -p "${JIRA_DEST}/lib"
mkdir -p "${DOWNSTREAM_ROOT}/scripts/jak-pipeline"

# Copy doctor.sh to scripts/jak-pipeline/ (project-level diagnostic tool)
doctor_src="${JAK_SKILL_ROOT}/scripts/doctor.sh"
if [ -f "$doctor_src" ]; then
  cp "$doctor_src" "${DOWNSTREAM_ROOT}/scripts/jak-pipeline/doctor.sh"
  chmod +x "${DOWNSTREAM_ROOT}/scripts/jak-pipeline/doctor.sh"
  echo "[Plan 3] ✓ Installed scripts/jak-pipeline/doctor.sh"
else
  PLAN3_ERRORS+=("MISSING: $doctor_src")
fi

for script in transition.sh provision-board.sh drain-retry-queue.sh tick-extension.sh; do
  src="${JIRA_SRC}/${script}"
  if [ -f "$src" ]; then
    cp "$src" "${JIRA_DEST}/${script}"
    chmod +x "${JIRA_DEST}/${script}"
    echo "[Plan 3] ✓ Installed scripts/jak-pipeline/jira/${script}"
  else
    PLAN3_ERRORS+=("MISSING: $src")
  fi
done

kanban_src="${JIRA_SRC}/lib/kanban-order.sh"
if [ -f "$kanban_src" ]; then
  cp "$kanban_src" "${JIRA_DEST}/lib/kanban-order.sh"
  chmod +x "${JIRA_DEST}/lib/kanban-order.sh"
  echo "[Plan 3] ✓ Installed scripts/jak-pipeline/jira/lib/kanban-order.sh"
else
  PLAN3_ERRORS+=("MISSING: $kanban_src")
fi

# (ii) Create .claude/jira/.env from template if not existing
JIRA_ENV="${DOWNSTREAM_ROOT}/.claude/jira/.env"
JIRA_ENV_TMPL="${JAK_SKILL_ROOT}/templates/jira/.env.example"
mkdir -p "$(dirname "$JIRA_ENV")"

if [ -f "$JIRA_ENV" ]; then
  echo "[Plan 3] ✓ .claude/jira/.env already exists (not overwritten)"
elif [ -f "$JIRA_ENV_TMPL" ]; then
  cp "$JIRA_ENV_TMPL" "$JIRA_ENV"
  echo "[Plan 3] ✓ Created .claude/jira/.env from template — fill in your credentials"
else
  cat > "$JIRA_ENV" << 'ENVEOF'
# DO NOT COMMIT. Fill in your actual Jira credentials.
JIRA_BASE_URL=
JIRA_EMAIL=
JIRA_API_TOKEN=
JIRA_PROJECT=
ENVEOF
  echo "[Plan 3] ✓ Created .claude/jira/.env (minimal template)"
fi

# (iii) Append tick.sh hook (idempotent via sentinel)
TICK_SH="${DOWNSTREAM_ROOT}/scripts/coordinator/tick.sh"
TICK_SENTINEL="jak_pipeline_jira_tick_pass"

if [ ! -f "$TICK_SH" ]; then
  echo "[Plan 3] SKIP tick.sh — $TICK_SH does not exist; create it first"
elif grep -qF "$TICK_SENTINEL" "$TICK_SH" 2>/dev/null; then
  echo "[Plan 3] ✓ tick.sh already registers jak_pipeline_jira_tick_pass (idempotent)"
else
  printf '\n# jak-pipeline: Jira tick pass\n. "$(dirname "${BASH_SOURCE[0]}")/jak-pipeline/jira/tick-extension.sh"\njak_pipeline_jira_tick_pass\n' >> "$TICK_SH"
  echo "[Plan 3] ✓ Appended jak_pipeline_jira_tick_pass to tick.sh"
fi

if [ ${#PLAN3_ERRORS[@]} -gt 0 ]; then
  echo "[Plan 3] ✗ Install errors:" >&2
  for err in "${PLAN3_ERRORS[@]}"; do
    echo "  - $err" >&2
  done
  exit 1
fi

echo "[Plan 3] ✓ Plan 3 install complete"

# ---------------------------------------------------------------------------
# TODO Plan 4 — install UAT environment Docker stack (default strategy
#   local-docker), Storybook preview-per-PR workflow, run the first
#   install on TnT Finance.
# ---------------------------------------------------------------------------

exit 0
