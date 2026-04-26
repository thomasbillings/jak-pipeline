import type { ToolDefinition } from '../server.js';

export const queueFreezesTool: ToolDefinition = {
  name: 'mergify_list_queue_freezes',
  description: 'List all current Mergify queue freezes (cached 60s).',
  inputSchema: {},
  async handler(_args: Record<string, unknown>, client: { listQueueFreezes(): Promise<unknown> }) {
    return await client.listQueueFreezes();
  },
};
