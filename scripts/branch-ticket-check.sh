#!/usr/bin/env bash
# branch-ticket-check.sh — validate a branch name against the jak-pipeline
# branch-ticket binding regex (architecture §4).
#
# Usage: branch-ticket-check.sh <branch_name>
# Exit 0 = valid; exit 1 = invalid (stderr message names branch + regex).
# Callable as a git pre-push hook or from CI / coordinator code.
#
# Project key resolution (priority order):
#   1. JIRA_TICKET_PROJECT_KEY — explicit override (CI / one-off bypass)
#   2. JIRA_PROJECT             — sourced from .claude/jira/.env when the
#                                 caller sources it; respected directly here
#   3. .claude/jira/.env's JIRA_PROJECT — auto-discovered from repo root
#   4. .coordinator-pipeline.json's `jira_project` field — auto-discovered.
#      NOT `.project`, which is the downstream consumer name (e.g.
#      "survaigo-ai") rather than a Jira project key.
#   5. SCRUM — legacy default; preserves backward compat for installs
#              without any of the above (TnT-Finance + older installs)
#
# GH- stays as a global escape hatch for branches anchored on a GitHub
# issue rather than a Jira ticket.

set -euo pipefail

BRANCH="${1:-}"

resolve_project_key() {
  if [[ -n "${JIRA_TICKET_PROJECT_KEY:-}" ]]; then
    echo "$JIRA_TICKET_PROJECT_KEY"
    return
  fi
  if [[ -n "${JIRA_PROJECT:-}" ]]; then
    echo "$JIRA_PROJECT"
    return
  fi
  local repo_root
  repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
  if [[ -n "$repo_root" ]]; then
    if [[ -f "$repo_root/.claude/jira/.env" ]]; then
      local from_env
      from_env="$(grep -E '^JIRA_PROJECT=' "$repo_root/.claude/jira/.env" 2>/dev/null \
        | head -1 | cut -d= -f2- | tr -d '"' | tr -d "'" || true)"
      if [[ -n "$from_env" ]]; then
        echo "$from_env"
        return
      fi
    fi
    if [[ -f "$repo_root/.coordinator-pipeline.json" ]] && command -v jq >/dev/null 2>&1; then
      local from_cfg
      from_cfg="$(jq -r '.jira_project // empty' \
        "$repo_root/.coordinator-pipeline.json" 2>/dev/null || true)"
      if [[ -n "$from_cfg" ]] && [[ "$from_cfg" != "null" ]]; then
        echo "$from_cfg"
        return
      fi
    fi
  fi
  echo "SCRUM"
}

PROJECT_KEY="$(resolve_project_key)"

REGEX="^(plan|feat|fix|chore|design|docs|test)/(${PROJECT_KEY}-[0-9]+|GH-[0-9]+)-[a-z0-9-]+\$"

if [[ -z "$BRANCH" ]]; then
  echo "branch-ticket-check: branch name is empty; expected pattern: ${REGEX}" >&2
  exit 1
fi

if echo "$BRANCH" | grep -qE "$REGEX"; then
  exit 0
else
  echo "branch-ticket-check: branch '${BRANCH}' does not match required pattern: ${REGEX}" >&2
  exit 1
fi
