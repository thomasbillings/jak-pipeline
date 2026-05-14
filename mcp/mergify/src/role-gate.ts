export type Role = 'scrum-master' | 'pr-reviewer' | 'dev-agent' | 'planner';
export type ToolName =
  | 'mergify_get_queue_summary'
  | 'mergify_get_queue_details'
  | 'mergify_check_pr_eligibility'
  | 'mergify_list_queue_freezes'
  | 'mergify_set_queue_state'
  | 'mergify_replay_pr';

export type GateResult = 'allow' | 'role-refused' | 'role-unrecognised';

const KNOWN_ROLES = new Set<Role>(['scrum-master', 'pr-reviewer', 'dev-agent', 'planner']);

// Per architecture.md §6 role-gate matrix
const MATRIX: Record<Role, Set<ToolName>> = {
  'scrum-master': new Set([
    'mergify_get_queue_summary',
    'mergify_get_queue_details',
    'mergify_check_pr_eligibility',
    'mergify_list_queue_freezes',
    'mergify_set_queue_state',
    'mergify_replay_pr',
  ]),
  'pr-reviewer': new Set([
    'mergify_get_queue_summary',
    'mergify_get_queue_details',
    'mergify_check_pr_eligibility',
    'mergify_list_queue_freezes',
  ]),
  'dev-agent': new Set([
    'mergify_get_queue_summary',
    'mergify_get_queue_details',
    'mergify_check_pr_eligibility',
  ]),
  planner: new Set(['mergify_get_queue_summary']),
};

export function gate(role: string | undefined, toolName: ToolName): GateResult {
  if (!role || !KNOWN_ROLES.has(role as Role)) {
    return 'role-unrecognised';
  }
  const allowed = MATRIX[role as Role];
  return allowed.has(toolName) ? 'allow' : 'role-refused';
}
