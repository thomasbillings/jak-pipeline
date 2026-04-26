import type { ToolDefinition } from '../server.js';

export const queueDetailsTool: ToolDefinition = {
  name: 'mergify_get_queue_details',
  description: 'Get queue details for a specific PR.',
  inputSchema: { pr: { type: 'number' as const, description: 'PR number', required: true } },
  async handler(args: Record<string, unknown>, client: { getQueueDetails(pr: number): Promise<unknown> }) {
    return await client.getQueueDetails(args['pr'] as number);
  },
};
