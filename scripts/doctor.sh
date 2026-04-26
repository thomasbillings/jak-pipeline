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

PLAN1_PASS=true
PLAN1_ERRORS=()

# ---------------------------------------------------------------------------
# Plan 1 checks — Mergify MCP server
# ---------------------------------------------------------------------------

MCP_DIR="$(dirname "$0")/../mcp/mergify"
MCP_DIR="$(cd "$MCP_DIR" && pwd)"

# (i) Verify <downstream>/.claude/mcp/mergify/.env exists with the four required keys.
# The downstream project root can be passed as DOWNSTREAM_ROOT or inferred from
# the caller's working directory. Fall back to a "not configured" warning.
DOWNSTREAM_ROOT="${DOWNSTREAM_ROOT:-}"
if [ -n "$DOWNSTREAM_ROOT" ]; then
  MCP_ENV="$DOWNSTREAM_ROOT/.claude/mcp/mergify/.env"
  if [ ! -f "$MCP_ENV" ]; then
    PLAN1_ERRORS+=("MISSING: $MCP_ENV — create it from mcp/mergify/.env.example")
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
else
  echo "[Plan 1] SKIP env-file check — set DOWNSTREAM_ROOT to enable"
fi

# (ii) Verify the built server dist/ exists (dry-run mode: no real Mergify org needed).
if [ -d "$MCP_DIR/dist" ] && [ -f "$MCP_DIR/dist/server.js" ]; then
  echo "[Plan 1] ✓ MCP server dist/server.js present"
else
  PLAN1_ERRORS+=("MISSING: $MCP_DIR/dist/server.js — run 'npm run build' in mcp/mergify/")
  PLAN1_PASS=false
fi

# (iii) Verify the redaction wrapper module can be imported (node --input-type=module).
if node --input-type=module - <<EOF 2>/dev/null
import { redactErrorEnvelope } from '${MCP_DIR}/dist/redaction.js';
const result = redactErrorEnvelope({ error: 'mrg_live_FAKE' });
if (result.error.includes('mrg_live_')) process.exit(1);
process.exit(0);
EOF
then
  echo "[Plan 1] ✓ Redaction wrapper importable and functional"
else
  PLAN1_ERRORS+=("FAIL: redaction wrapper not importable — run 'npm run build' in mcp/mergify/ first")
  PLAN1_PASS=false
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

# ---------------------------------------------------------------------------
# Plan 2 — Mergify config + label trust boundary
# ---------------------------------------------------------------------------

PLAN2_PASS=true
PLAN2_ERRORS=()

DOWNSTREAM_ROOT="${DOWNSTREAM_ROOT:-$PWD}"
JAK_SENTINEL="<!-- jak-pipeline:pr-reviewer-label-gate v1 -->"

# (i) Verify .mergify.yml exists and parses as YAML
MERGIFY_YML="${DOWNSTREAM_ROOT}/.mergify.yml"
if [ ! -f "$MERGIFY_YML" ]; then
  PLAN2_ERRORS+=("MISSING: $MERGIFY_YML — run install.sh to create it")
  PLAN2_PASS=false
else
  if python3 -c "import yaml; yaml.safe_load(open('${MERGIFY_YML}'))" 2>/dev/null; then
    echo "[Plan 2] ✓ .mergify.yml exists and parses as valid YAML"
    if command -v mergify &>/dev/null; then
      if mergify validate "$MERGIFY_YML" 2>/dev/null; then
        echo "[Plan 2] ✓ mergify validate passed"
      else
        echo "[Plan 2] WARN: mergify validate failed for $MERGIFY_YML (check schema)" >&2
      fi
    fi
  else
    PLAN2_ERRORS+=("FAIL: $MERGIFY_YML does not parse as valid YAML")
    PLAN2_PASS=false
  fi
fi

# (ii) Verify .claude/agents/pr-reviewer.md contains label-gate sentinel comment
PR_REVIEWER="${DOWNSTREAM_ROOT}/.claude/agents/pr-reviewer.md"
if [ ! -f "$PR_REVIEWER" ]; then
  PLAN2_ERRORS+=("MISSING: $PR_REVIEWER")
  PLAN2_PASS=false
elif grep -qF "$JAK_SENTINEL" "$PR_REVIEWER" 2>/dev/null; then
  echo "[Plan 2] ✓ pr-reviewer.md contains label-gate sentinel"
else
  PLAN2_ERRORS+=("MISSING sentinel in $PR_REVIEWER — run install.sh to append overlay")
  PLAN2_PASS=false
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
# TODO Plan 3 — verify Jira credentials with a no-op read, confirm
#   agents/_jira-retry.json is empty (or surface stuck items),
#   confirm tick.sh's drift reconciliation pass is registered.
# ---------------------------------------------------------------------------

# ---------------------------------------------------------------------------
# TODO Plan 4 — verify UAT strategy is configured, Docker stack can build,
#   Storybook preview workflow exists in .github/workflows/,
#   Cloudflare Pages project (or chosen alternative) is reachable.
# ---------------------------------------------------------------------------

if $PLAN1_PASS && $PLAN2_PASS; then
  exit 0
else
  exit 1
fi
