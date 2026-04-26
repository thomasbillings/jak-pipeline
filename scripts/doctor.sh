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

echo "scaffold-only — see Plan 1 (MCP server), Plan 2 (Mergify config + agents), Plan 3 (Jira), Plan 4 (UAT + first install)"
exit 1
