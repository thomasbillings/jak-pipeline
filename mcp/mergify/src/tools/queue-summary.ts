import type { ToolDefinition } from '../server.js';

export const queueSummaryTool: ToolDefinition = {
  name: 'mergify_get_queue_summary',
  description: 'Get a summary of all Mergify queues (cached 30s).',
  inputSchema: {},
  async handler(_args: Record<string, unknown>, client: { getQueueSummary(): Promise<unknown> }) {
    return await client.getQueueSummary();
  },
};
