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
if node --input-type=module <<'EOF' 2>/dev/null
import { redactErrorEnvelope } from '$MCP_DIR/dist/redaction.js';
const result = redactErrorEnvelope({ error: 'mrg_live_FAKE' });
if (result.error.includes('mrg_live_')) process.exit(1);
process.exit(0);
EOF
then
  echo "[Plan 1] ✓ Redaction wrapper importable and functional"
elif node --input-type=module - <<EOF 2>/dev/null
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
# TODO Plan 2 — verify .mergify.yml parses, queue conditions reference
#   currently-defined CI checks, _label-log.jsonl is writable, the
#   pr-reviewer agent declares the correct label-trust gate.
# ---------------------------------------------------------------------------

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

if $PLAN1_PASS; then
  exit 0
else
  exit 1
fi
