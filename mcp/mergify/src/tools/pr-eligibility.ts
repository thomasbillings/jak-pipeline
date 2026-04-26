import type { ToolDefinition } from '../server.js';

export const prEligibilityTool: ToolDefinition = {
  name: 'mergify_check_pr_eligibility',
  description: 'Check whether a PR is eligible to enter the merge queue.',
  inputSchema: { pr: { type: 'number' as const, description: 'PR number' } },
  async handler(args: Record<string, unknown>, client: { checkPrEligibility(pr: number): Promise<unknown> }) {
    return await client.checkPrEligibility(args['pr'] as number);
  },
};
