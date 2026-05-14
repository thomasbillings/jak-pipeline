#!/usr/bin/env bash
set -euo pipefail

# install.sh — install the jak-pipeline skill into a target project.
#
# Run from inside the target project's root (or set JAK_DOWNSTREAM_ROOT).
# JAK_SKILL_ROOT — path to the jak-pipeline skill repo (defaults to this script's parent).

JAK_SKILL_ROOT="${JAK_SKILL_ROOT:-$(cd "$(dirname "$0")/.." && pwd)}"
DOWNSTREAM_ROOT="${JAK_DOWNSTREAM_ROOT:-${DOWNSTREAM_ROOT:-$PWD}}"

# ---------------------------------------------------------------------------
# Pre-flight — verify the downstream is ready to receive an install.
# ---------------------------------------------------------------------------
#
# JAK_SKIP_PREFLIGHT=1   bypass all pre-flight checks (test fixtures, recovery
#                       installs where you know the environment is OK).
# JAK_REMOTE_CHECKS=1   additionally run remote checks: GitHub branch protection
#                       on main, Mergify GitHub App install. Defaults off so the
#                       script doesn't make network calls without explicit opt-in.

PREFLIGHT_ERRORS=()
PREFLIGHT_WARNINGS=()

if [[ "${JAK_SKIP_PREFLIGHT:-0}" == "1" ]]; then
  echo "[Pre-flight] SKIP (JAK_SKIP_PREFLIGHT=1)"
else

# (a) Required CLIs on the install machine
for cli in gh python3 flock node bash; do
  if ! command -v "$cli" >/dev/null 2>&1; then
    PREFLIGHT_ERRORS+=("MISSING CLI: $cli — install it before running install.sh")
  fi
done

# Node >= 20
if command -v node >/dev/null 2>&1; then
  _node_major=$(node -e 'process.stdout.write(String(process.versions.node.split(".")[0]))')
  if [ "$_node_major" -lt 20 ] 2>/dev/null; then
    PREFLIGHT_ERRORS+=("Node version ${_node_major} too old — node ≥ 20 required (MCP server uses ESM + top-level await)")
  fi
fi

# Bash >= 4 (associative arrays, [[ ]] features)
_bash_major="${BASH_VERSINFO[0]:-0}"
if [ "$_bash_major" -lt 4 ] 2>/dev/null; then
  PREFLIGHT_ERRORS+=("Bash version $_bash_major too old — bash ≥ 4 required")
fi

# (b) coordinator-pipeline must already be installed
# The skill assumes <downstream>/scripts/coordinator/tick.sh exists and the
# pr-reviewer agent file is present at .claude/agents/pr-reviewer.md.
# (b1) coordinator-pipeline scaffolding is no longer a prerequisite — Plan 0
# installs it directly. We still check tick.sh later to decide whether Plan 0's
# work is fresh-install vs idempotent re-run.

# (c) Downstream is a git repo (Mergify operates on PRs)
if [ ! -d "${DOWNSTREAM_ROOT}/.git" ]; then
  PREFLIGHT_ERRORS+=("MISSING: ${DOWNSTREAM_ROOT} is not a git repository — run 'git init' first")
fi

# (d) Optional remote checks
if [[ "${JAK_REMOTE_CHECKS:-0}" == "1" ]]; then
  if command -v gh >/dev/null 2>&1; then
    # Determine owner/repo from git remote
    _origin=$(git -C "${DOWNSTREAM_ROOT}" remote get-url origin 2>/dev/null || true)
    if [ -z "$_origin" ]; then
      PREFLIGHT_WARNINGS+=("WARN: no 'origin' git remote — skipping remote checks")
    else
      _owner_repo=$(echo "$_origin" | sed -E 's#.*[:/]([^/]+/[^/.]+)(\.git)?$#\1#')
      # Branch protection on main
      if gh api "repos/${_owner_repo}/branches/main/protection" >/dev/null 2>&1; then
        echo "[Pre-flight] ✓ Branch protection on main is active"
      else
        PREFLIGHT_WARNINGS+=("WARN: branch protection on main is NOT active for ${_owner_repo} — Mergify queues only mean something when main is protected. See: https://docs.github.com/en/repositories/configuring-branches-and-merges-in-your-repository/managing-protected-branches")
      fi
      # Mergify GitHub App install (probe — best effort)
      if gh api "repos/${_owner_repo}/installation" 2>/dev/null | grep -qi mergify; then
        echo "[Pre-flight] ✓ Mergify GitHub App appears installed"
      else
        PREFLIGHT_WARNINGS+=("WARN: could not confirm Mergify GitHub App is installed on ${_owner_repo} — install at https://github.com/apps/mergify before activating queues")
      fi
    fi
  fi
fi

# Report
for err in "${PREFLIGHT_ERRORS[@]:-}"; do
  echo "[Pre-flight] ✗ $err" >&2
done
for warn in "${PREFLIGHT_WARNINGS[@]:-}"; do
  echo "[Pre-flight] $warn" >&2
done

if [ ${#PREFLIGHT_ERRORS[@]} -gt 0 ]; then
  echo "[Pre-flight] ✗ Hard checks failed — aborting. Set JAK_SKIP_PREFLIGHT=1 to bypass (not recommended)." >&2
  exit 1
fi

echo "[Pre-flight] ✓ All hard checks passed"
fi  # end: JAK_SKIP_PREFLIGHT != 1

# ---------------------------------------------------------------------------
# Plan 0 — Coordinator pipeline scaffolding
# ---------------------------------------------------------------------------
#
# Absorbed from the (formerly separate) coordinator-pipeline skill. Installs
# the planner / plan-reviewer / dev-agent / coordinator-tick template files
# and the tick.sh / dispatch.sh / lib.sh / check-plan.sh coordinator scripts.
# Idempotent — never overwrites a pre-existing file.
#
# JAK_PLAN_REPO    set to <owner>/<repo> to opt into plan-repo mode non-
#                  interactively (writes .coordinator-pipeline.json on first run)
# JAK_PROJECT_NAME project name used in plan-repo mode (defaults to basename of
#                  DOWNSTREAM_ROOT)
# PLAN0_ONLY=1     limits this run to Plan 0 only (test-fixture mode)

PLAN0_ONLY="${PLAN0_ONLY:-0}"
PLAN0_ERRORS=()

# (i) Pipeline config (.coordinator-pipeline.json) for plan-repo mode
PIPELINE_CONFIG="${DOWNSTREAM_ROOT}/.coordinator-pipeline.json"
if [ -f "$PIPELINE_CONFIG" ]; then
  echo "[Plan 0] ✓ .coordinator-pipeline.json already present (idempotent)"
elif [ -n "${JAK_PLAN_REPO:-}" ]; then
  _project="${JAK_PROJECT_NAME:-$(basename "$DOWNSTREAM_ROOT")}"
  cat > "$PIPELINE_CONFIG" <<EOF
{
  "plan_repo": "${JAK_PLAN_REPO}",
  "project": "${_project}"
}
EOF
  echo "[Plan 0] ✓ Created .coordinator-pipeline.json (plan_repo=${JAK_PLAN_REPO}, project=${_project})"
elif [ -t 0 ]; then
  echo "[Plan 0] Plan-repo mode? Plans can live in a separate GitHub repo so they don't"
  echo "[Plan 0]   contend with code PRs on this repo's CI queue."
  echo "[Plan 0]   Leave blank for legacy mode (plans live in this repo's plans/)."
  printf "[Plan 0]   plan_repo (e.g. thomasbillings/survaigo-plans) [blank=skip]: "
  read -r _plan_repo_input || _plan_repo_input=""
  if [ -n "$_plan_repo_input" ]; then
    _default_project="$(basename "$DOWNSTREAM_ROOT")"
    printf "[Plan 0]   project name [%s]: " "$_default_project"
    read -r _project_input || _project_input=""
    _project_final="${_project_input:-$_default_project}"
    cat > "$PIPELINE_CONFIG" <<EOF
{
  "plan_repo": "$_plan_repo_input",
  "project": "$_project_final"
}
EOF
    echo "[Plan 0] ✓ Created .coordinator-pipeline.json (plan_repo=$_plan_repo_input, project=$_project_final)"
  else
    echo "[Plan 0] Legacy mode — plans/ stays local"
  fi
else
  echo "[Plan 0] Legacy mode — plans/ stays local (set JAK_PLAN_REPO to opt into plan-repo mode)"
fi

# (ii) Create coordinator directories
mkdir -p "$DOWNSTREAM_ROOT/plans" "$DOWNSTREAM_ROOT/agents" "$DOWNSTREAM_ROOT/agents/archive" \
         "$DOWNSTREAM_ROOT/.claude/agents" "$DOWNSTREAM_ROOT/.claude/commands" \
         "$DOWNSTREAM_ROOT/scripts/coordinator"

# (iii) Copy templates — never overwrite (user may have customised)
_copy_if_missing() {
  local src="$1" dst="$2" label="$3"
  if [ ! -f "$src" ]; then
    PLAN0_ERRORS+=("MISSING source: $src")
    return
  fi
  if [ -f "$dst" ]; then
    echo "[Plan 0] ✓ ${label} already present (idempotent — not overwritten)"
  else
    cp "$src" "$dst"
    echo "[Plan 0] ✓ Installed ${label}"
  fi
}

_copy_if_missing "${JAK_SKILL_ROOT}/templates/agents/planner.md"        "$DOWNSTREAM_ROOT/.claude/agents/planner.md"        ".claude/agents/planner.md"
_copy_if_missing "${JAK_SKILL_ROOT}/templates/agents/plan-reviewer.md"  "$DOWNSTREAM_ROOT/.claude/agents/plan-reviewer.md"  ".claude/agents/plan-reviewer.md"
_copy_if_missing "${JAK_SKILL_ROOT}/templates/agents/dev-agent.md"      "$DOWNSTREAM_ROOT/.claude/agents/dev-agent.md"      ".claude/agents/dev-agent.md"
_copy_if_missing "${JAK_SKILL_ROOT}/templates/commands/coordinator-tick.md" "$DOWNSTREAM_ROOT/.claude/commands/coordinator-tick.md" ".claude/commands/coordinator-tick.md"
_copy_if_missing "${JAK_SKILL_ROOT}/templates/plans/plan-template.md"   "$DOWNSTREAM_ROOT/plans/_template.md"               "plans/_template.md"

# Coordinator scripts (tick.sh, dispatch.sh, lib.sh, check-plan.sh).
# Idempotent — never overwrite, per the bootstrap.sh contract. To refresh on
# an update, delete the specific file first then re-run install.sh.
for s in tick.sh dispatch.sh lib.sh check-plan.sh; do
  src="${JAK_SKILL_ROOT}/scripts/coordinator/${s}"
  dst="$DOWNSTREAM_ROOT/scripts/coordinator/${s}"
  if [ ! -f "$src" ]; then
    PLAN0_ERRORS+=("MISSING source: $src")
  elif [ -f "$dst" ]; then
    echo "[Plan 0] ✓ scripts/coordinator/${s} already present (idempotent)"
  else
    cp "$src" "$dst"
    chmod +x "$dst"
    echo "[Plan 0] ✓ Installed scripts/coordinator/${s}"
  fi
done

# (iv) Append gitignore additions (sentinel: avoid duplicate appends)
GITIGNORE="$DOWNSTREAM_ROOT/.gitignore"
GITIGNORE_TMPL="${JAK_SKILL_ROOT}/templates/gitignore-additions.txt"
GITIGNORE_MARKER="# coordinator pipeline — agent state"
if [ ! -f "$GITIGNORE_TMPL" ]; then
  PLAN0_ERRORS+=("MISSING: $GITIGNORE_TMPL")
elif [ -f "$GITIGNORE" ] && grep -qF "$GITIGNORE_MARKER" "$GITIGNORE"; then
  echo "[Plan 0] ✓ .gitignore already has coordinator/jak-pipeline rules (idempotent)"
else
  if [ -f "$GITIGNORE" ]; then
    # Make sure we don't double up; append a newline first if file doesn't end with one
    [ -n "$(tail -c 1 "$GITIGNORE")" ] && printf '\n' >> "$GITIGNORE"
  fi
  cat "$GITIGNORE_TMPL" >> "$GITIGNORE"
  echo "[Plan 0] ✓ Appended coordinator/jak-pipeline rules to .gitignore"
fi

if [ ${#PLAN0_ERRORS[@]} -gt 0 ]; then
  echo "[Plan 0] ✗ Install errors:" >&2
  for err in "${PLAN0_ERRORS[@]}"; do echo "  - $err" >&2; done
  exit 1
fi

echo "[Plan 0] ✓ Plan 0 install complete"

if [[ "$PLAN0_ONLY" == "1" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Plan 1 — Mergify MCP server install
# ---------------------------------------------------------------------------

# PLAN1_ONLY=1 limits this run to the Plan 1 section (test-fixture mode).
PLAN1_ONLY="${PLAN1_ONLY:-0}"
PLAN1_ERRORS=()

# (i) Build the MCP server if dist/ is missing
MCP_SRC="${JAK_SKILL_ROOT}/mcp/mergify"
if [ ! -f "${MCP_SRC}/dist/server.js" ]; then
  if [[ "${JAK_PLAN1_SKIP_NPM:-0}" == "1" ]]; then
    PLAN1_ERRORS+=("dist/server.js missing — pre-build mcp/mergify (npm run build) before running install.sh with JAK_PLAN1_SKIP_NPM=1")
  else
    echo "[Plan 1] Building MCP server (npm ci + npm run build)..."
    (cd "$MCP_SRC" && npm ci --silent && npm run build --silent) || \
      PLAN1_ERRORS+=("FAIL: could not build MCP server at ${MCP_SRC} — run 'cd mcp/mergify && npm ci && npm run build' in the skill repo first")
  fi
fi

# (ii) Copy MCP server into <downstream>/.claude/mcp/mergify/
MCP_DEST="${DOWNSTREAM_ROOT}/.claude/mcp/mergify"
if [ -d "${MCP_DEST}" ]; then
  # Already installed — refresh dist/ + src/ (idempotent — never touches user .env)
  mkdir -p "${MCP_DEST}/dist" "${MCP_DEST}/src"
  cp -r "${MCP_SRC}/dist/." "${MCP_DEST}/dist/"
  cp -r "${MCP_SRC}/src/." "${MCP_DEST}/src/"
  cp "${MCP_SRC}/package.json" "${MCP_DEST}/package.json"
  cp "${MCP_SRC}/package-lock.json" "${MCP_DEST}/package-lock.json"
  cp "${MCP_SRC}/tsconfig.json" "${MCP_DEST}/tsconfig.json" 2>/dev/null || true
  echo "[Plan 1] ✓ Refreshed MCP server dist/+src/ at ${MCP_DEST} (idempotent — .env preserved)"
else
  mkdir -p "${MCP_DEST}"
  cp -r "${MCP_SRC}/dist" "${MCP_DEST}/dist"
  cp -r "${MCP_SRC}/src" "${MCP_DEST}/src"
  cp "${MCP_SRC}/package.json" "${MCP_DEST}/package.json"
  cp "${MCP_SRC}/package-lock.json" "${MCP_DEST}/package-lock.json"
  cp "${MCP_SRC}/tsconfig.json" "${MCP_DEST}/tsconfig.json" 2>/dev/null || true
  cp "${MCP_SRC}/README.md" "${MCP_DEST}/README.md" 2>/dev/null || true
  echo "[Plan 1] ✓ Copied MCP server to ${MCP_DEST}"
fi

# (iii) Install runtime deps in destination
# JAK_PLAN1_SKIP_NPM=1 — test-only flag to skip the npm ci step (saves ~5s per test).
# Production installs should never set this.
if [[ "${JAK_PLAN1_SKIP_NPM:-0}" == "1" ]]; then
  echo "[Plan 1] SKIP npm ci --omit=dev (JAK_PLAN1_SKIP_NPM=1 — test mode)"
else
  (cd "${MCP_DEST}" && npm ci --omit=dev --silent 2>/dev/null) && \
    echo "[Plan 1] ✓ Installed runtime deps (npm ci --omit=dev)" || \
    PLAN1_ERRORS+=("WARN: 'npm ci --omit=dev' in ${MCP_DEST} failed — runtime deps may be missing")
fi

# (iv) Template .env from .env.example
MCP_ENV_TMPL="${MCP_SRC}/.env.example"
MCP_ENV="${MCP_DEST}/.env"
if [ -f "${MCP_ENV}" ]; then
  echo "[Plan 1] ✓ .env already exists (not overwritten — fill in credentials manually)"
elif [ -f "${MCP_ENV_TMPL}" ]; then
  cp "${MCP_ENV_TMPL}" "${MCP_ENV}"
  echo "[Plan 1] ✓ Created .env from template — fill in your credentials before first MCP call"
else
  cat > "${MCP_ENV}" <<'ENVEOF'
# DO NOT COMMIT. Fill in real credentials.
MERGIFY_API_KEY=
MERGIFY_ORG=
GITHUB_TOKEN=
MERGIFY_MCP_ROLE=coordinator
ENVEOF
  echo "[Plan 1] ✓ Created .env (minimal template)"
fi

# (v) Generate run.sh wrapper (sources .env then execs node — keeps secrets out of .mcp.json)
MCP_RUN_SH="${MCP_DEST}/run.sh"
cat > "${MCP_RUN_SH}" <<'RUNEOF'
#!/usr/bin/env bash
# Wrapper: sources .env then execs the Mergify MCP server.
# Generated by jak-pipeline install.sh — do not edit by hand; re-run install.sh to refresh.
set -e
cd "$(dirname "$(readlink -f "${BASH_SOURCE[0]}")")"
if [ -f ./.env ]; then
  set -a; . ./.env; set +a
fi
exec node ./dist/server.js
RUNEOF
chmod +x "${MCP_RUN_SH}"
echo "[Plan 1] ✓ Wrote run.sh wrapper"

# (vi) Register server with Claude Code via project-scope .mcp.json (idempotent JSON merge)
MCP_JSON="${DOWNSTREAM_ROOT}/.mcp.json"
python3 - "$MCP_JSON" "${DOWNSTREAM_ROOT}" <<'PYEOF' || PLAN1_ERRORS+=("FAIL: could not write .mcp.json")
import json, os, sys, pathlib
mcp_json_path, downstream_root = sys.argv[1], sys.argv[2]
p = pathlib.Path(mcp_json_path)
data = {}
if p.exists():
    try:
        data = json.loads(p.read_text())
    except Exception:
        # Backup the broken file and start fresh
        p.rename(str(p) + '.backup')
        data = {}
data.setdefault('mcpServers', {})
data['mcpServers']['mergify'] = {
    'command': 'bash',
    'args': [str(pathlib.Path('.claude') / 'mcp' / 'mergify' / 'run.sh')],
}
p.write_text(json.dumps(data, indent=2) + '\n')
PYEOF
echo "[Plan 1] ✓ Registered 'mergify' MCP server in ${MCP_JSON}"

# (vii) Install pre-commit token-prefix hook
PRE_COMMIT_SRC="${JAK_SKILL_ROOT}/scripts/hooks/pre-commit"
PRE_COMMIT_SENTINEL="# jak-pipeline pre-commit token-prefix scan"

if [ ! -f "${PRE_COMMIT_SRC}" ]; then
  PLAN1_ERRORS+=("MISSING: ${PRE_COMMIT_SRC}")
elif [ -d "${DOWNSTREAM_ROOT}/.husky" ]; then
  PC_DEST="${DOWNSTREAM_ROOT}/.husky/pre-commit"
  if grep -qF "${PRE_COMMIT_SENTINEL}" "${PC_DEST}" 2>/dev/null; then
    echo "[Plan 1] ✓ pre-commit hook already installed in .husky (idempotent)"
  else
    if [ ! -f "${PC_DEST}" ]; then
      echo "#!/usr/bin/env sh" > "${PC_DEST}"
      echo ". \"\$(dirname -- \"\$0\")/_/husky.sh\"" >> "${PC_DEST}"
    fi
    {
      echo ""
      echo "${PRE_COMMIT_SENTINEL}"
      echo "bash \"\$(git rev-parse --show-toplevel)/scripts/hooks/pre-commit\""
    } >> "${PC_DEST}"
    chmod +x "${PC_DEST}"
    echo "[Plan 1] ✓ Installed pre-commit hook into .husky/pre-commit"
  fi
else
  PC_DEST="${DOWNSTREAM_ROOT}/.git/hooks/pre-commit"
  mkdir -p "$(dirname "${PC_DEST}")"
  if [ -f "${PC_DEST}" ] && grep -qF "${PRE_COMMIT_SENTINEL}" "${PC_DEST}" 2>/dev/null; then
    echo "[Plan 1] ✓ pre-commit hook already installed (idempotent)"
  else
    # Copy the hook source into the project's scripts/hooks/ (downstream-owned) and dispatch via .git/hooks
    mkdir -p "${DOWNSTREAM_ROOT}/scripts/hooks"
    cp "${PRE_COMMIT_SRC}" "${DOWNSTREAM_ROOT}/scripts/hooks/pre-commit"
    chmod +x "${DOWNSTREAM_ROOT}/scripts/hooks/pre-commit"
    if [ ! -f "${PC_DEST}" ]; then
      echo "#!/usr/bin/env bash" > "${PC_DEST}"
    fi
    {
      echo ""
      echo "${PRE_COMMIT_SENTINEL}"
      echo "bash \"\$(git rev-parse --show-toplevel)/scripts/hooks/pre-commit\""
    } >> "${PC_DEST}"
    chmod +x "${PC_DEST}"
    echo "[Plan 1] ✓ Installed pre-commit hook into .git/hooks/pre-commit"
  fi
fi

if [ ${#PLAN1_ERRORS[@]} -gt 0 ]; then
  echo "[Plan 1] ✗ Install warnings/errors:" >&2
  for err in "${PLAN1_ERRORS[@]}"; do
    echo "  - $err" >&2
  done
fi

echo "[Plan 1] ✓ Plan 1 install complete"

if [[ "$PLAN1_ONLY" == "1" ]]; then
  exit 0
fi

# ---------------------------------------------------------------------------
# Plan 2 — Mergify config + label trust boundary + branch-ticket binding
# ---------------------------------------------------------------------------

# PLAN3_ONLY=1 limits this run to the Plan 3 section (used by Plan 3 install
# tests against a Jira-only fixture, which doesn't have .claude/agents/ or .git/).
PLAN3_ONLY="${PLAN3_ONLY:-0}"
if [[ "$PLAN3_ONLY" == "1" ]]; then
  echo "[Plan 2] SKIP (PLAN3_ONLY=1)"
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

# (ii) Install the pr-reviewer agent template (copy-if-missing)
# The pr-reviewer agent (templates/agents/pr-reviewer.md) ships the full
# review rubric + label-gate logic baked in. Replaces the historical overlay-
# append model (Plan 2 used to append a sentinel-bounded block onto a
# pre-existing pr-reviewer.md, which only worked if a downstream pre-shipped
# one — coordinator-pipeline never did).
PR_REVIEWER_SRC="${JAK_SKILL_ROOT}/templates/agents/pr-reviewer.md"
PR_REVIEWER_DEST="${DOWNSTREAM_ROOT}/.claude/agents/pr-reviewer.md"

if [ ! -f "$PR_REVIEWER_SRC" ]; then
  PLAN2_ERRORS+=("MISSING: $PR_REVIEWER_SRC")
elif [ -f "$PR_REVIEWER_DEST" ]; then
  echo "[Plan 2] ✓ .claude/agents/pr-reviewer.md already present (idempotent — not overwritten)"
else
  mkdir -p "$(dirname "$PR_REVIEWER_DEST")"
  cp "$PR_REVIEWER_SRC" "$PR_REVIEWER_DEST"
  echo "[Plan 2] ✓ Installed .claude/agents/pr-reviewer.md"
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

# (v) agents/_label-log.jsonl is covered by the Plan 0 .gitignore template
# (templates/gitignore-additions.txt) — no per-line append needed here.

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

# --- Step (iii.5): copy UAT lifecycle scripts ---
# Runbook §4 (UAT rollback) references these paths; they're the dispatcher
# and the four local-docker lifecycle scripts.
UAT_SCRIPTS_DEST="${DOWNSTREAM_ROOT}/scripts/jak-pipeline/uat"
UAT_SCRIPTS_SRC="${JAK_SKILL_ROOT}/scripts/uat"
mkdir -p "$UAT_SCRIPTS_DEST"
for script in run.sh local-docker-start.sh local-docker-stop.sh local-docker-accept.sh local-docker-reject.sh; do
  src="${UAT_SCRIPTS_SRC}/${script}"
  dest="${UAT_SCRIPTS_DEST}/${script}"
  if [ ! -f "$src" ]; then
    PLAN4_ERRORS+=("MISSING: $src — run 'git pull' in jak-pipeline skill")
  else
    cp "$src" "$dest"
    chmod +x "$dest"
    echo "[Plan 4] ✓ Installed scripts/jak-pipeline/uat/${script}"
  fi
done

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
    # Write an empty marker so doctor.sh can distinguish "user skipped" from
    # "config.env missing or corrupted". Doctor surfaces empty CF_PAGES_PROJECT
    # as a configurable, not a defect.
    printf 'CF_PAGES_PROJECT=\n' >> "$PLAN4_CONFIG_ENV"
    echo "[Plan 4] SKIP CF_PAGES_PROJECT — wrote empty marker to config.env (set CF_PAGES_PROJECT env var on re-run or edit config.env manually)"
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
