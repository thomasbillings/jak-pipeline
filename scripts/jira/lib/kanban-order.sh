#!/usr/bin/env bash
# Kanban state ordering for jak-pipeline.
# Source this file; it exports KANBAN_STATES array and helper functions.
# Single source of truth for ordering — kanban-states.md is the human doc.

KANBAN_STATES=(
  "Idea"
  "Backlog"
  "Planning"
  "Plan Review"
  "Ready to Dev"
  "In Development"
  "PR Review"
  "Merge Queue"
  "UAT"
  "Done"
  "Blocked"
  "Cancelled"
)

# kanban_index_of <state> → sets KANBAN_IDX to the 0-based index, or -1 if not found.
kanban_index_of() {
  local target="$1"
  local i
  for i in "${!KANBAN_STATES[@]}"; do
    if [[ "${KANBAN_STATES[$i]}" == "$target" ]]; then
      KANBAN_IDX=$i
      return 0
    fi
  done
  KANBAN_IDX=-1
  return 1
}

# kanban_is_backward <from> <to> → returns 0 (true) if this is a backward transition.
# "Backward" means the target index is strictly less than the from index.
# Blocked and Cancelled are sidebar/terminal states — transitions involving them
# are never classified as backward (special handling in transition.sh).
kanban_is_backward() {
  local from="$1"
  local to="$2"

  kanban_index_of "$from"; local from_idx=$KANBAN_IDX
  kanban_index_of "$to";   local to_idx=$KANBAN_IDX

  # Unknown states: not backward (transition.sh will handle invalid states separately)
  if [[ $from_idx -eq -1 ]] || [[ $to_idx -eq -1 ]]; then
    return 1
  fi

  # Blocked and Cancelled are special — not subject to backward rule
  if [[ "$to" == "Blocked" ]] || [[ "$to" == "Cancelled" ]]; then
    return 1
  fi
  if [[ "$from" == "Blocked" ]] || [[ "$from" == "Cancelled" ]]; then
    return 1
  fi

  # Strict less-than: target earlier in forward order than current
  [[ $to_idx -lt $from_idx ]]
}
