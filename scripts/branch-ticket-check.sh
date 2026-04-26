#!/usr/bin/env bash
# branch-ticket-check.sh — validate a branch name against the jak-pipeline
# branch-ticket binding regex (architecture §4).
#
# Usage: branch-ticket-check.sh <branch_name>
# Exit 0 = valid; exit 1 = invalid (stderr message names branch + regex).
# Callable as a git pre-push hook or from CI / coordinator code.

set -euo pipefail

BRANCH="${1:-}"

REGEX='^(plan|feat|fix|chore|design|docs|test)/(SCRUM-[0-9]+|GH-[0-9]+)-[a-z0-9-]+$'

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
