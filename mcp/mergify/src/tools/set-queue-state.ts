import type { ToolDefinition } from '../server.js';

export const setQueueStateTool: ToolDefinition = {
  name: 'mergify_set_queue_state',
  description: 'Set the Mergify queue state (coordinator only).',
  inputSchema: {
    state: { type: 'string' as const, description: 'Queue state: "locked" or "unlocked"', required: true },
    reason: { type: 'string' as const, description: 'Reason for the state change', required: true },
  },
  async handler(args: Record<string, unknown>, client: { setQueueState(state: string, reason: string): Promise<unknown> }) {
    return await client.setQueueState(args['state'] as string, args['reason'] as string);
  },
};
