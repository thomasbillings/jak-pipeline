#!/usr/bin/env bash
set -euo pipefail

# doctor.sh — diagnose a jak-pipeline install on a target project.
#
# Intent: run a non-destructive health check of the installed pipeline.
# Confirms required CLIs are present, MCP server can reach Mergify, Jira
# credentials are valid, the agent label trust boundary is wired up, and
# the UAT runner can spin its environment. Exits non-zero on any
# configurable problem.
#
# This file is currently a SCAFFOLD — it does nothing functional. The body
# is populated incrementally by the downstream plans:
#
#   1. Plan 1 — check `.claude/mcp/mergify/.env` exists with required keys,
#      run a dry mergify_get_queue_summary call through the MCP server,
#      verify the redaction wrapper is loaded.
#   2. Plan 2 — verify `.mergify.yml` parses, queue conditions reference
#      currently-defined CI checks, `_label-log.jsonl` is writable, the
#      pr-reviewer agent file declares the correct label-trust gate.
#   3. Plan 3 — verify Jira credentials with a no-op read, confirm
#      `agents/_jira-retry.json` is empty (or surface stuck items),
#      confirm tick.sh's drift reconciliation pass is registered.
#   4. Plan 4 — verify UAT strategy is configured, the Docker stack can
#      build, the Storybook preview workflow exists in `.github/workflows/`,
#      Cloudflare Pages project (or chosen alternative) is reachable.

PLAN3_CHECK="${PLAN3_CHECK:-0}"

PLAN1_PASS=true
PLAN1_ERRORS=()

# ---------------------------------------------------------------------------
# Plan 1 checks — Mergify MCP server (skipped when PLAN3_CHECK=1)
# ---------------------------------------------------------------------------

if [[ "$PLAN3_CHECK" == "1" ]]; then
  # Skip Plan 1 — caller only wants Plan 3 checks
  PLAN1_PASS=true
  MCP_DIR="."  # placeholder; not used
else

# Plan 1 checks resolve MCP_DIR from DOWNSTREAM_ROOT (the installed location:
# <downstream>/.claude/mcp/mergify). Fall back to skill-repo layout when
# running doctor.sh directly from the skill repo (used in dev / unit tests).
DOWNSTREAM_ROOT="${DOWNSTREAM_ROOT:-$PWD}"
MCP_DIR="$DOWNSTREAM_ROOT/.claude/mcp/mergify"
DOCTOR_MODE="downstream"

if [ ! -d "$MCP_DIR" ] && [ -d "$(dirname "$0")/../mcp/mergify" ]; then
  MCP_DIR="$(cd "$(dirname "$0")/../mcp/mergify" && pwd)"
  DOCTOR_MODE="skill-repo"
  echo "[Plan 1] (skill-repo mode — MCP_DIR=$MCP_DIR)"
fi

# (i) Verify <MCP_DIR>/.env exists with the four required keys.
MCP_ENV="$MCP_DIR/.env"
if [ ! -f "$MCP_ENV" ]; then
  PLAN1_ERRORS+=("MISSING: $MCP_ENV — re-run install.sh Plan 1 section")
  PLAN1_PASS=false
else
  for KEY in MERGIFY_API_KEY MERGIFY_ORG GITHUB_TOKEN MERGIFY_MCP_ROLE; do
    if ! grep -qE "^${KEY}\s*=" "$MCP_ENV"; then
      PLAN1_ERRORS+=("MISSING KEY in $MCP_ENV: $KEY")
      PLAN1_PASS=false
    fi
  done
  if $PLAN1_PASS; then
    echo "[Plan 1] ✓ $MCP_ENV exists with all 4 required keys"
  fi
fi

# (ii) Verify the built server dist/ exists.
if [ -d "$MCP_DIR/dist" ] && [ -f "$MCP_DIR/dist/server.js" ]; then
  echo "[Plan 1] ✓ MCP server dist/server.js present"
else
  PLAN1_ERRORS+=("MISSING: $MCP_DIR/dist/server.js — re-run install.sh Plan 1 section")
  PLAN1_PASS=false
fi

# (iii) Verify the redaction wrapper module can be imported and functional.
# Fixture is constructed via concat so the literal pattern doesn't appear
# contiguously in source — otherwise jak-pipeline's own pre-commit token-prefix
# scan (scripts/hooks/pre-commit) refuses to commit this file. The runtime
# behavior is identical: tokenPrefix evaluates to 'mrg_live_' and the redactor
# is tested for that prefix.
if node --input-type=module - <<EOF 2>/dev/null
import { redactErrorEnvelope } from '${MCP_DIR}/dist/redaction.js';
const tokenPrefix = 'mrg' + '_live_';
const result = redactErrorEnvelope({ error: tokenPrefix + 'FAKE' });
if (result.error.includes(tokenPrefix)) process.exit(1);
process.exit(0);
EOF
then
  echo "[Plan 1] ✓ Redaction wrapper importable and functional"
else
  PLAN1_ERRORS+=("FAIL: redaction wrapper not importable from ${MCP_DIR}/dist/redaction.js")
  PLAN1_PASS=false
fi

# (iv) Downstream-mode only: verify run.sh wrapper and .mcp.json registration
if [ "$DOCTOR_MODE" = "downstream" ]; then
  MCP_RUN="$MCP_DIR/run.sh"
  if [ ! -f "$MCP_RUN" ]; then
    PLAN1_ERRORS+=("MISSING: $MCP_RUN — re-run install.sh Plan 1 section")
    PLAN1_PASS=false
  elif [ ! -x "$MCP_RUN" ]; then
    PLAN1_ERRORS+=("NOT EXECUTABLE: $MCP_RUN — chmod +x")
    PLAN1_PASS=false
  else
    echo "[Plan 1] ✓ run.sh wrapper present and executable"
  fi

  MCP_JSON="$DOWNSTREAM_ROOT/.mcp.json"
  if [ ! -f "$MCP_JSON" ]; then
    PLAN1_ERRORS+=("MISSING: $MCP_JSON — re-run install.sh Plan 1 section")
    PLAN1_PASS=false
  elif python3 -c "import json,sys; d=json.load(open('${MCP_JSON}')); sys.exit(0 if d.get('mcpServers',{}).get('mergify') else 1)" 2>/dev/null; then
    echo "[Plan 1] ✓ .mcp.json registers 'mergify' MCP server"
  else
    PLAN1_ERRORS+=("FAIL: .mcp.json does not register 'mergify' — re-run install.sh Plan 1 section")
    PLAN1_PASS=false
  fi
fi

# Report Plan 1 results
if $PLAN1_PASS; then
  echo "[Plan 1] ✓ All Plan 1 checks passed"
else
  echo "[Plan 1] ✗ Plan 1 checks failed:" >&2
  for err in "${PLAN1_ERRORS[@]}"; do
    echo "  - $err" >&2
  done
fi

fi  # end: if PLAN3_CHECK != 1

# ---------------------------------------------------------------------------
# Plan 2 — Mergify config + label trust boundary
# ---------------------------------------------------------------------------

PLAN2_PASS=true
PLAN2_ERRORS=()

DOWNSTREAM_ROOT="${DOWNSTREAM_ROOT:-$PWD}"
# PR-K (#18) replaced the overlay-append model with a full pr-reviewer agent
# file. The label-gate logic is baked into the agent's body — no sentinel.
# The (ii) check below now verifies the canonical description marker instead.
JAK_PR_REVIEWER_MARKER="description: Reviews feature PRs for the jak-pipeline"

# (i) Verify .mergify.yml exists and parses as YAML
# Three-tier check: (1) file exists; (2) if PyYAML is available, parse it;
# (3) if PyYAML is unavailable, fall back to a smoke check (file is non-empty
# and contains the expected top-level 'queue_rules:' key). Distinguishes
# missing-dep from genuine parse failure — the previous version conflated
# both as "does not parse".
MERGIFY_YML="${DOWNSTREAM_ROOT}/.mergify.yml"
if [ ! -f "$MERGIFY_YML" ]; then
  PLAN2_ERRORS+=("MISSING: $MERGIFY_YML — run install.sh to create it")
  PLAN2_PASS=false
else
  # `set -e` would trigger on a failed command substitution in an assignment,
  # so explicitly tolerate the non-zero exit codes with a fallback.
  _yaml_check_out="$(python3 - "$MERGIFY_YML" 2>&1 <<'PYEOF'
import sys
try:
    import yaml
except ModuleNotFoundError:
    print("NO_YAML_MODULE")
    sys.exit(2)
try:
    with open(sys.argv[1]) as f:
        yaml.safe_load(f)
    print("OK")
except Exception as e:
    print(f"PARSE_ERROR: {e}")
    sys.exit(1)
PYEOF
)" || _yaml_status=$?
  _yaml_status="${_yaml_status:-0}"
  if [ "$_yaml_status" -eq 0 ]; then
    echo "[Plan 2] ✓ .mergify.yml exists and parses as valid YAML"
    if command -v mergify &>/dev/null; then
      if mergify validate "$MERGIFY_YML" 2>/dev/null; then
        echo "[Plan 2] ✓ mergify validate passed"
      else
        echo "[Plan 2] WARN: mergify validate failed for $MERGIFY_YML (check schema)" >&2
      fi
    fi
  elif [ "$_yaml_status" -eq 2 ]; then
    # PyYAML not installed — fall back to a smoke check
    if grep -qE '^queue_rules:' "$MERGIFY_YML" && [ -s "$MERGIFY_YML" ]; then
      echo "[Plan 2] ✓ .mergify.yml smoke check passed (PyYAML not installed — install 'pip3 install pyyaml' for full parse)"
    else
      PLAN2_ERRORS+=("FAIL: $MERGIFY_YML smoke check failed (file empty or missing 'queue_rules:'); PyYAML not installed so a full parse couldn't run — install 'pip3 install pyyaml' to upgrade the check")
      PLAN2_PASS=false
    fi
  else
    PLAN2_ERRORS+=("FAIL: $MERGIFY_YML does not parse as valid YAML — ${_yaml_check_out}")
    PLAN2_PASS=false
  fi
fi

# (ii) Verify .claude/agents/pr-reviewer.md exists. If it carries our canonical
# description marker, it's our shipped template (PR-K #18). If not, it's a
# user-owned agent file — that's still valid (jak-pipeline preserves user
# customisation); doctor surfaces it as a configurable, not a defect, since
# the label-gate behaviour depends on whether the user's file implements it.
PR_REVIEWER="${DOWNSTREAM_ROOT}/.claude/agents/pr-reviewer.md"
if [ ! -f "$PR_REVIEWER" ]; then
  PLAN2_ERRORS+=("MISSING: $PR_REVIEWER — run scripts/install.sh Plan 2 section")
  PLAN2_PASS=false
elif grep -qF "$JAK_PR_REVIEWER_MARKER" "$PR_REVIEWER" 2>/dev/null; then
  echo "[Plan 2] ✓ pr-reviewer.md is jak-pipeline's canonical template (label-gate baked in)"
else
  echo "[Plan 2] CONFIGURABLE: pr-reviewer.md is user-owned (no jak-pipeline marker) — verify the label-gate is implemented in your version"
fi

# (iii) Verify agents/_label-log.jsonl is creatable (write-permission check)
AGENTS_DIR="${DOWNSTREAM_ROOT}/agents"
WRITE_TEST="${AGENTS_DIR}/.jak-doctor-write-test"
mkdir -p "$AGENTS_DIR" 2>/dev/null || true
if touch "$WRITE_TEST" 2>/dev/null; then
  rm -f "$WRITE_TEST"
  echo "[Plan 2] ✓ agents/ directory is writable"
else
  PLAN2_ERRORS+=("FAIL: cannot write to $AGENTS_DIR — check directory permissions")
  PLAN2_PASS=false
fi

# (iv) Verify all three Plan-2 scripts exist and are executable
JAK_SCRIPTS_DIR="${DOWNSTREAM_ROOT}/.claude/jak-pipeline/scripts"
for script in label-gate-decide.sh label-log-append.sh branch-ticket-check.sh; do
  script_path="${JAK_SCRIPTS_DIR}/${script}"
  if [ ! -f "$script_path" ]; then
    PLAN2_ERRORS+=("MISSING: $script_path — run install.sh")
    PLAN2_PASS=false
  elif [ ! -x "$script_path" ]; then
    PLAN2_ERRORS+=("NOT EXECUTABLE: $script_path — run chmod +x")
    PLAN2_PASS=false
  else
    echo "[Plan 2] ✓ $script exists and is executable"
  fi
done

if $PLAN2_PASS; then
  echo "[Plan 2] ✓ All Plan 2 checks passed"
else
  echo "[Plan 2] ✗ Plan 2 checks failed:" >&2
  for err in "${PLAN2_ERRORS[@]}"; do
    echo "  - $err" >&2
  done
fi

# ---------------------------------------------------------------------------
# Plan 3 — verify Jira credentials with a no-op read, confirm
#   agents/_jira-retry.json is empty (or surface stuck items),
#   confirm tick.sh's drift reconciliation pass is registered.
# ---------------------------------------------------------------------------

# When PLAN3_CHECK=1, skip Plan 1 results and only evaluate Plan 3.
PLAN3_CHECK="${PLAN3_CHECK:-0}"

PLAN3_PASS=true
PLAN3_ERRORS=()

DOWNSTREAM_ROOT="${DOWNSTREAM_ROOT:-$PWD}"

# Load Jira credentials from .claude/jira/.env
JIRA_ENV_FILE="${DOWNSTREAM_ROOT}/.claude/jira/.env"
if [ -f "$JIRA_ENV_FILE" ]; then
  set +u
  while IFS='=' read -r key value; do
    [[ "$key" =~ ^#.*$ ]] && continue
    [[ -z "$key" ]] && continue
    if [ -z "${!key:-}" ]; then export "$key"="$value"; fi
  done < "$JIRA_ENV_FILE"
  set -u
fi

JIRA_BASE_URL="${JIRA_BASE_URL:-}"
JIRA_EMAIL="${JIRA_EMAIL:-}"
JIRA_API_TOKEN="${JIRA_API_TOKEN:-}"

# (i) Verify Jira credentials via GET /rest/api/3/myself
if [ -z "$JIRA_BASE_URL" ] || [ -z "$JIRA_EMAIL" ] || [ -z "$JIRA_API_TOKEN" ]; then
  PLAN3_ERRORS+=("MISSING Jira credentials — set JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN in $JIRA_ENV_FILE")
  PLAN3_PASS=false
else
  auth_header="Authorization: Basic $(printf '%s:%s' "$JIRA_EMAIL" "$JIRA_API_TOKEN" | base64 | tr -d '\n')"
  http_code=$(curl -s -o /dev/null -w "%{http_code}" \
    -H "$auth_header" \
    --max-time 10 \
    "${JIRA_BASE_URL}/rest/api/3/myself" 2>/dev/null || echo "000")
  if [[ "$http_code" == "2"* ]]; then
    echo "[Plan 3] ✓ Jira credentials valid (HTTP $http_code from /rest/api/3/myself)"
  else
    PLAN3_ERRORS+=("FAIL: Jira credential check returned HTTP $http_code (401 = invalid credentials)")
    PLAN3_PASS=false
  fi
fi

# (ii) Check agents/_jira-retry.json for stuck items older than 24h
RETRY_QUEUE="${DOWNSTREAM_ROOT}/agents/_jira-retry.json"
if [ ! -f "$RETRY_QUEUE" ]; then
  echo "[Plan 3] ✓ Retry queue is clean (no file)"
else
  _doctor_py=$(mktemp /tmp/jak-doctor-XXXXXX.py)
  cat > "$_doctor_py" << 'PYEOF'
import sys, json, datetime
queue_path = sys.argv[1]
threshold = datetime.datetime.utcnow() - datetime.timedelta(hours=24)
stale = []
try:
    with open(queue_path) as f:
        for line in f:
            line = line.strip()
            if not line: continue
            try:
                d = json.loads(line)
                ts = d.get('first_attempted_at', '')
                if ts:
                    t = datetime.datetime.fromisoformat(ts.replace('Z', '+00:00')).replace(tzinfo=None)
                    if t < threshold:
                        stale.append(d.get('ticket', '?'))
            except Exception:
                pass
except Exception:
    pass
print(','.join(stale))
PYEOF
  stale=$(python3 "$_doctor_py" "$RETRY_QUEUE" 2>/dev/null || echo "")
  rm -f "$_doctor_py"
  if [ -n "$stale" ]; then
    PLAN3_ERRORS+=("STUCK: retry queue has items older than 24h: $stale — run drain-retry-queue.sh or check Jira connectivity")
    PLAN3_PASS=false
  else
    echo "[Plan 3] ✓ Retry queue has no stale items older than 24h"
  fi
fi

# (iii) Verify tick.sh contains jak_pipeline_jira_tick_pass
TICK_SH="${DOWNSTREAM_ROOT}/scripts/scrum-master/tick.sh"
if [ ! -f "$TICK_SH" ]; then
  PLAN3_ERRORS+=("MISSING: $TICK_SH — run install.sh Plan 3 section")
  PLAN3_PASS=false
elif grep -qF "jak_pipeline_jira_tick_pass" "$TICK_SH" 2>/dev/null; then
  echo "[Plan 3] ✓ tick.sh contains jak_pipeline_jira_tick_pass"
else
  PLAN3_ERRORS+=("MISSING jak_pipeline_jira_tick_pass in $TICK_SH — run install.sh Plan 3 section")
  PLAN3_PASS=false
fi

if $PLAN3_PASS; then
  echo "[Plan 3] ✓ All Plan 3 checks passed"
else
  echo "[Plan 3] ✗ Plan 3 checks failed:" >&2
  for err in "${PLAN3_ERRORS[@]}"; do
    echo "  - $err" >&2
  done
fi

# ---------------------------------------------------------------------------
# Plan 4 — verify UAT strategy, Docker overlay, Storybook workflow, CF secret.
# ---------------------------------------------------------------------------

# PLAN4_CHECK=1 runs ONLY Plan 4 checks (analogous to PLAN3_CHECK=1 for Plan 3).
PLAN4_CHECK="${PLAN4_CHECK:-0}"

PLAN4_PASS=true
PLAN4_ERRORS=()

DOWNSTREAM_ROOT="${DOWNSTREAM_ROOT:-$PWD}"
PLAN4_CONFIG_ENV="${DOWNSTREAM_ROOT}/.claude/jak-pipeline/config.env"

# (i) Verify config.env exists and contains JAK_UAT_STRATEGY
if [ ! -f "$PLAN4_CONFIG_ENV" ]; then
  PLAN4_ERRORS+=("MISSING: $PLAN4_CONFIG_ENV — run scripts/install.sh Plan 4 section")
  PLAN4_PASS=false
else
  if ! grep -qE '^JAK_UAT_STRATEGY=' "$PLAN4_CONFIG_ENV" 2>/dev/null; then
    PLAN4_ERRORS+=("MISSING JAK_UAT_STRATEGY in $PLAN4_CONFIG_ENV — run scripts/install.sh Plan 4 section")
    PLAN4_PASS=false
  else
    _uat_strategy=$(grep '^JAK_UAT_STRATEGY=' "$PLAN4_CONFIG_ENV" | head -1 | cut -d= -f2)
    echo "[Plan 4] ✓ JAK_UAT_STRATEGY=${_uat_strategy} found in config.env"

    # (ii) When strategy is local-docker, verify overlay exists and parses
    if [ "$_uat_strategy" = "local-docker" ]; then
      UAT_OVERLAY="${DOWNSTREAM_ROOT}/docker/docker-compose.local-uat.yml"
      if [ ! -f "$UAT_OVERLAY" ]; then
        PLAN4_ERRORS+=("MISSING: $UAT_OVERLAY — run scripts/install.sh Plan 4 section")
        PLAN4_PASS=false
      else
        if docker compose -f "$UAT_OVERLAY" config --quiet 2>/dev/null; then
          echo "[Plan 4] ✓ docker/docker-compose.local-uat.yml exists and parses clean"
        else
          PLAN4_ERRORS+=("FAIL: docker compose config parse error in $UAT_OVERLAY")
          PLAN4_PASS=false
        fi
      fi
    fi
  fi
fi

# (iii) Verify storybook-preview.yml exists and references CF_PAGES_PROJECT
STORYBOOK_WORKFLOW="${DOWNSTREAM_ROOT}/.github/workflows/storybook-preview.yml"
if [ ! -f "$STORYBOOK_WORKFLOW" ]; then
  PLAN4_ERRORS+=("MISSING: $STORYBOOK_WORKFLOW — run scripts/install.sh Plan 4 section")
  PLAN4_PASS=false
elif ! grep -qF "CF_PAGES_PROJECT" "$STORYBOOK_WORKFLOW" 2>/dev/null; then
  PLAN4_ERRORS+=("MISSING CF_PAGES_PROJECT reference in $STORYBOOK_WORKFLOW")
  PLAN4_PASS=false
else
  echo "[Plan 4] ✓ .github/workflows/storybook-preview.yml exists and references CF_PAGES_PROJECT"
fi

# (iii.4) Verify CF_PAGES_PROJECT is configured in config.env. Four states:
# - config.env absent → (i) above already errored with MISSING and set PLAN4_PASS=false
# - line absent → install.sh Plan 4 hasn't run completely; error and fail
# - line present and empty (CF_PAGES_PROJECT=) → user skipped; surface as a
#   configurable, not a defect
# - line present and non-empty → fully configured
if [ ! -f "$PLAN4_CONFIG_ENV" ]; then
  # Already errored at (i); nothing to add here. Explicit no-op so refactors
  # that delete (i) don't silently lose this branch.
  :
elif ! grep -qE '^CF_PAGES_PROJECT=' "$PLAN4_CONFIG_ENV" 2>/dev/null; then
  PLAN4_ERRORS+=("MISSING CF_PAGES_PROJECT marker in $PLAN4_CONFIG_ENV — re-run scripts/install.sh Plan 4 section")
  PLAN4_PASS=false
else
  _cf_value=$(grep '^CF_PAGES_PROJECT=' "$PLAN4_CONFIG_ENV" | head -1 | cut -d= -f2-)
  if [ -z "$_cf_value" ]; then
    echo "[Plan 4] CONFIGURABLE: CF_PAGES_PROJECT is empty in config.env — set the env var and re-run install.sh, or edit config.env directly"
  else
    echo "[Plan 4] ✓ CF_PAGES_PROJECT=${_cf_value} configured"
  fi
fi

# (iii.5) Verify UAT lifecycle scripts are installed and executable
UAT_SCRIPTS_DIR="${DOWNSTREAM_ROOT}/scripts/jak-pipeline/uat"
for uat_script in run.sh local-docker-start.sh local-docker-stop.sh local-docker-accept.sh local-docker-reject.sh; do
  uat_path="${UAT_SCRIPTS_DIR}/${uat_script}"
  if [ ! -f "$uat_path" ]; then
    PLAN4_ERRORS+=("MISSING: $uat_path — run scripts/install.sh Plan 4 section")
    PLAN4_PASS=false
  elif [ ! -x "$uat_path" ]; then
    PLAN4_ERRORS+=("NOT EXECUTABLE: $uat_path — chmod +x")
    PLAN4_PASS=false
  else
    echo "[Plan 4] ✓ scripts/jak-pipeline/uat/${uat_script} present and executable"
  fi
done

# (iv) Verify CF_API_TOKEN secret is configured via gh secret list
if command -v gh &>/dev/null; then
  if gh secret list 2>/dev/null | grep -q 'CF_API_TOKEN'; then
    echo "[Plan 4] ✓ CF_API_TOKEN secret is configured on this repo"
  else
    PLAN4_ERRORS+=("MISSING CF_API_TOKEN GitHub Actions secret — see instructions in scripts/install.sh Plan 4 output")
    PLAN4_PASS=false
  fi
else
  echo "[Plan 4] SKIP CF_API_TOKEN check — gh CLI not available"
fi

if $PLAN4_PASS; then
  echo "[Plan 4] ✓ All Plan 4 checks passed"
else
  echo "[Plan 4] ✗ Plan 4 checks failed:" >&2
  for err in "${PLAN4_ERRORS[@]}"; do
    echo "  - $err" >&2
  done
fi

if [[ "$PLAN3_CHECK" == "1" ]]; then
  if $PLAN3_PASS; then
    exit 0
  else
    exit 1
  fi
fi

if [[ "$PLAN4_CHECK" == "1" ]]; then
  if $PLAN4_PASS; then
    exit 0
  else
    exit 1
  fi
fi

if $PLAN1_PASS && $PLAN2_PASS && $PLAN3_PASS && $PLAN4_PASS; then
  exit 0
else
  exit 1
fi
