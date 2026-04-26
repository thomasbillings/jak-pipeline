#!/usr/bin/env bash
set -euo pipefail

# uninstall.sh — remove the jak-pipeline skill from a target project.
#
# Intent: cleanly reverse install.sh. Removes installed agent files,
# Mergify config, MCP server registration, Jira integration, and UAT
# scaffolding from the downstream repo. Should leave plan files and
# `agents/` history untouched (audit) unless --purge is passed.
#
# This file is currently a SCAFFOLD — it does nothing functional. The body
# is populated incrementally by the downstream plans:
#
#   1. Plan 1 — remove MCP server registration from `.claude/mcp/`,
#      delete redaction wrapper, prompt-then-delete env file.
#   2. Plan 2 — remove `.mergify.yml`, the named-queue config, the agent
#      files responsible for `queue:*` labels, and the `_label-log.jsonl`
#      writer. Restore the previous workflow if `auto-update-prs.yml`
#      was retired during install.
#   3. Plan 3 — remove the Jira transition helper, deregister the drift
#      reconciliation pass from `tick.sh`, drain `_jira-retry.json`.
#   4. Plan 4 — tear down UAT Docker stack, remove Storybook preview
#      workflow.

echo "scaffold-only — see Plan 1 (MCP server), Plan 2 (Mergify config + agents), Plan 3 (Jira), Plan 4 (UAT + first install)"
exit 1
