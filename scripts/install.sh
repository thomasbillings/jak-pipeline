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

# PLAN3_ONLY=1 limits this run to the Plan 3 section (used by Plan 3 install
# tests against a Jira-only fixture, which doesn't have .claude/agents/ or .git/).
PLAN3_ONLY="${PLAN3_ONLY:-0}"
if [[ "$PLAN3_ONLY" == "1" ]]; then
  echo "[Plan 2] SKIP (PLAN3_ONLY=1 — Plan 3 only)"
else

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
  # Ensure .git/hooks/ exists — git creates it automatically, but a non-git
  # downstream (test fixture, fresh sandbox) won't have it.
  mkdir -p "$(dirname "$HOOK_FILE")"
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

fi  # end: PLAN3_ONLY != 1 (Plan 2 wrapper)

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
  printf '\n# jak-pipeline: Jira tick pass\n. "$(dirname "${BASH_SOURCE[0]}")/../jak-pipeline/jira/tick-extension.sh"\njak_pipeline_jira_tick_pass\n' >> "$TICK_SH"
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
# ## --- Plan 4 ---
# UAT strategy, local-docker overlay, Storybook preview workflow.
# ---------------------------------------------------------------------------

PLAN4_ONLY="${PLAN4_ONLY:-0}"
if [[ "$PLAN3_ONLY" == "1" && "$PLAN4_ONLY" != "1" ]]; then
  # Caller limited to Plan 3; skip Plan 4
  exit 0
fi

PLAN4_ERRORS=()
PLAN4_CONFIG_ENV="${DOWNSTREAM_ROOT}/.claude/jak-pipeline/config.env"
PLAN4_SENTINEL_UAT="jak_pipeline_plan4_uat"

# --- Step (i): prompt for UAT strategy and write to config.env ---
mkdir -p "$(dirname "$PLAN4_CONFIG_ENV")"

if grep -qF "$PLAN4_SENTINEL_UAT" "$PLAN4_CONFIG_ENV" 2>/dev/null; then
  echo "[Plan 4] ✓ UAT strategy already configured (idempotent)"
else
  # Non-interactive: check JAK_UAT_STRATEGY env; else prompt
  _strategy="${JAK_UAT_STRATEGY:-}"
  if [ -z "$_strategy" ] && [ -t 0 ]; then
    echo "[Plan 4] Choose a UAT strategy:"
    echo "  1) local-docker  (default — separate Docker Compose stack on dev machine)"
    echo "  2) vercel-preview"
    echo "  3) fly-staging"
    echo "  4) none          (skip UAT gate)"
    read -r -p "  Strategy [1]: " _choice
    case "${_choice:-1}" in
      1|local-docker) _strategy="local-docker" ;;
      2|vercel-preview) _strategy="vercel-preview" ;;
      3|fly-staging) _strategy="fly-staging" ;;
      4|none) _strategy="none" ;;
      *) _strategy="local-docker" ;;
    esac
  fi
  _strategy="${_strategy:-local-docker}"

  {
    echo "# jak-pipeline config — generated by scripts/install.sh Plan 4"
    echo "# DO NOT add secrets here. CF_API_TOKEN belongs in GitHub Actions secrets."
    echo "JAK_UAT_STRATEGY=${_strategy}"
    echo "# ${PLAN4_SENTINEL_UAT}"
  } >> "$PLAN4_CONFIG_ENV"
  echo "[Plan 4] ✓ Wrote JAK_UAT_STRATEGY=${_strategy} to .claude/jak-pipeline/config.env"
fi

# --- Step (ii): copy local-docker overlay when strategy is local-docker ---
UAT_OVERLAY_DEST="${DOWNSTREAM_ROOT}/docker/docker-compose.local-uat.yml"
UAT_OVERLAY_SRC="${JAK_SKILL_ROOT}/templates/uat/local-docker/docker-compose.uat.yml"

current_strategy=$(grep '^JAK_UAT_STRATEGY=' "$PLAN4_CONFIG_ENV" 2>/dev/null | head -1 | cut -d= -f2 || true)

if [ "${current_strategy:-}" = "local-docker" ]; then
  if [ -f "$UAT_OVERLAY_DEST" ]; then
    echo "[Plan 4] ✓ docker/docker-compose.local-uat.yml already exists (idempotent)"
  elif [ -f "$UAT_OVERLAY_SRC" ]; then
    mkdir -p "$(dirname "$UAT_OVERLAY_DEST")"
    cp "$UAT_OVERLAY_SRC" "$UAT_OVERLAY_DEST"
    echo "[Plan 4] ✓ Installed docker/docker-compose.local-uat.yml"
    echo "[Plan 4]   NOTE: this is the LOCAL UAT overlay (jak-pipeline gate, per-PR)."
    echo "[Plan 4]   Any existing docker-compose.uat.yml (production UAT) is untouched."
  else
    PLAN4_ERRORS+=("MISSING: $UAT_OVERLAY_SRC — run 'git pull' in jak-pipeline skill")
  fi
fi

# --- Step (iii): copy Storybook preview workflow ---
STORYBOOK_DEST="${DOWNSTREAM_ROOT}/.github/workflows/storybook-preview.yml"
STORYBOOK_SRC="${JAK_SKILL_ROOT}/templates/github-actions/storybook-preview.yml"

if [ -f "$STORYBOOK_DEST" ]; then
  echo "[Plan 4] ✓ .github/workflows/storybook-preview.yml already exists (idempotent)"
elif [ -f "$STORYBOOK_SRC" ]; then
  mkdir -p "$(dirname "$STORYBOOK_DEST")"
  cp "$STORYBOOK_SRC" "$STORYBOOK_DEST"
  echo "[Plan 4] ✓ Installed .github/workflows/storybook-preview.yml"
else
  PLAN4_ERRORS+=("MISSING: $STORYBOOK_SRC — run 'git pull' in jak-pipeline skill")
fi

# --- Step (iv): prompt for CF_PAGES_PROJECT ---
PLAN4_CF_SENTINEL="CF_PAGES_PROJECT"

if grep -qF "$PLAN4_CF_SENTINEL" "$PLAN4_CONFIG_ENV" 2>/dev/null; then
  echo "[Plan 4] ✓ CF_PAGES_PROJECT already set in config.env (idempotent)"
else
  _cf_project="${CF_PAGES_PROJECT:-}"
  if [ -z "$_cf_project" ] && [ -t 0 ]; then
    read -r -p "[Plan 4] Enter your Cloudflare Pages project name: " _cf_project
  fi
  if [ -n "$_cf_project" ]; then
    # Validate: CF Pages project names are lowercase alphanumeric + hyphens only
    if [[ ! "$_cf_project" =~ ^[a-z0-9]([a-z0-9-]*[a-z0-9])?$ ]]; then
      echo "[Plan 4] ERROR: CF_PAGES_PROJECT must be lowercase alphanumeric with hyphens (got: ${_cf_project})" >&2
      PLAN4_ERRORS+=("INVALID CF_PAGES_PROJECT: ${_cf_project}")
    else
      printf 'CF_PAGES_PROJECT=%s\n' "$_cf_project" >> "$PLAN4_CONFIG_ENV"
      echo "[Plan 4] ✓ Wrote CF_PAGES_PROJECT=${_cf_project} to config.env"
      # Update the storybook workflow placeholder if just installed
      if [ -f "$STORYBOOK_DEST" ]; then
        # Safe: validated above to be [a-z0-9-] only — no sed metacharacter risk
        sed -i.bak "s/your-cf-pages-project/${_cf_project}/g" "$STORYBOOK_DEST" && rm -f "${STORYBOOK_DEST}.bak"
        echo "[Plan 4] ✓ Updated CF_PAGES_PROJECT in storybook-preview.yml"
      fi
    fi
  else
    echo "[Plan 4] SKIP CF_PAGES_PROJECT — set CF_PAGES_PROJECT env var or edit config.env manually"
  fi
fi

# --- Step (v): instruct user to set CF_API_TOKEN as GitHub Actions secret ---
echo "[Plan 4]"
echo "[Plan 4] IMPORTANT: Add CF_API_TOKEN as a GitHub Actions secret:"
echo "[Plan 4]   1. Go to your repo → Settings → Secrets and variables → Actions"
echo "[Plan 4]   2. Click 'New repository secret'"
echo "[Plan 4]   3. Name: CF_API_TOKEN"
echo "[Plan 4]   4. Value: your Cloudflare API token (Pages edit permission)"
echo "[Plan 4]   DO NOT write the token to disk or to config.env."
echo "[Plan 4]"

if [ ${#PLAN4_ERRORS[@]} -gt 0 ]; then
  echo "[Plan 4] ✗ Install errors:" >&2
  for err in "${PLAN4_ERRORS[@]}"; do
    echo "  - $err" >&2
  done
  exit 1
fi

echo "[Plan 4] ✓ Plan 4 install complete"

exit 0
