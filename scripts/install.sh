#!/usr/bin/env bash
set -euo pipefail

# install.sh — install the jak-pipeline skill into a target project.
#
# Intent: bootstrap a downstream repo with the Mergify config, agent files,
# coordinator scripts, MCP server, Jira integration, and UAT scaffolding
# that this skill provides. Run from inside the target project's root.
#
# This file is currently a SCAFFOLD — it does nothing functional. The body
# is populated incrementally by the downstream plans:
#
#   1. Plan 1 — wire up Mergify MCP server (mcp/mergify/) into target's
#      `.claude/mcp/` and seed the redaction wrapper + env-file template.
#   2. Plan 2 — copy `.mergify.yml.tmpl` + named-queue config; install
#      agent files that apply `queue:*` labels gated on BLOCKERs=0 +
#      tests-green; install `agents/_label-log.jsonl` writer.
#   3. Plan 3 — provision the Jira board (idempotent), install the
#      transition helper, register the drift reconciliation pass with the
#      coordinator's `tick.sh`, install `agents/_jira-retry.json` queue.
#   4. Plan 4 — install UAT environment Docker stack (default strategy
#      `local-docker`), Storybook preview-per-PR workflow, run the first
#      install on TnT Finance.

echo "scaffold-only — see Plan 1 (MCP server), Plan 2 (Mergify config + agents), Plan 3 (Jira), Plan 4 (UAT + first install)"
exit 1
