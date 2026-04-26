import type { ToolDefinition } from '../server.js';

export const replayPrTool: ToolDefinition = {
  name: 'mergify_replay_pr',
  description: 'Replay a PR through the Mergify queue (coordinator only).',
  inputSchema: {
    pr: { type: 'number' as const, description: 'PR number to replay' },
    reason: { type: 'string' as const, description: 'Reason for the replay' },
  },
  async handler(args: Record<string, unknown>, client: { replayPr(pr: number, reason: string): Promise<unknown> }) {
    return await client.replayPr(args['pr'] as number, args['reason'] as string);
  },
};
