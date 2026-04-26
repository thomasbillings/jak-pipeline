#!/usr/bin/env bash
set -euo pipefail

# run.sh — UAT strategy dispatcher.
# Reads JAK_UAT_STRATEGY from env and dispatches to the appropriate lifecycle script.
# JAK_UAT_OVERLAY — absolute path to the docker-compose overlay (required for local-docker).

JAK_UAT_STRATEGY="${JAK_UAT_STRATEGY:-}"
JAK_UAT_OVERLAY="${JAK_UAT_OVERLAY:-}"

# Resolve the directory containing the lifecycle scripts.
# JAK_UAT_SCRIPTS_DIR overrides the default (sibling scripts dir) — used in tests.
SCRIPT_DIR="${JAK_UAT_SCRIPTS_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"

case "$JAK_UAT_STRATEGY" in
  none)
    exit 0
    ;;
  local-docker)
    exec "${SCRIPT_DIR}/local-docker-start.sh" "$JAK_UAT_OVERLAY"
    ;;
  vercel-preview)
    echo "stub — see Plan 4+ or community contribution for vercel-preview UAT strategy"
    exit 0
    ;;
  fly-staging)
    echo "stub — see Plan 4+ or community contribution for fly-staging UAT strategy"
    exit 0
    ;;
  "")
    echo "[uat/run.sh] ERROR: JAK_UAT_STRATEGY is not set" >&2
    exit 1
    ;;
  *)
    echo "[uat/run.sh] ERROR: unknown UAT strategy '${JAK_UAT_STRATEGY}'. Supported: local-docker | vercel-preview | fly-staging | none" >&2
    exit 1
    ;;
esac
