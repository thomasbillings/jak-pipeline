import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { gate, type ToolName } from './role-gate.js';
import { redactErrorEnvelope, type ErrorEnvelope } from './redaction.js';
import { createCache } from './cache.js';
import { createMergifyClient } from './mergify-client.js';
import { checkEnvLeakGuard } from './env-leak-guard.js';

export interface ToolDefinition {
  name: ToolName;
  description: string;
  inputSchema: Record<string, { type: 'string' | 'number'; description: string; required?: boolean }>;
  handler(args: Record<string, unknown>, client: MergifyClient): Promise<unknown>;
}

export interface MergifyClient {
  getQueueSummary(): Promise<unknown>;
  getQueueDetails(pr: number): Promise<unknown>;
  checkPrEligibility(pr: number): Promise<unknown>;
  listQueueFreezes(): Promise<unknown>;
  setQueueState(state: string, reason: string): Promise<unknown>;
  replayPr(pr: number, reason: string): Promise<unknown>;
}

export type RoleGateResult =
  | { type: 'allow'; result: unknown }
  | { type: 'role-refused'; role: string; tool: string }
  | { type: 'role-unrecognised'; role: string; tool: string };

export interface TestServer {
  invokeWithRole(role: string | undefined, toolName: string, args?: Record<string, unknown>): Promise<RoleGateResult>;
}

const TOOL_DEFS: ToolDefinition[] = [];
let _toolsRegistered = false;

async function loadTools(): Promise<ToolDefinition[]> {
  if (TOOL_DEFS.length > 0) return TOOL_DEFS;
  const [
    { queueSummaryTool },
    { queueDetailsTool },
    { prEligibilityTool },
    { queueFreezesTool },
    { setQueueStateTool },
    { replayPrTool },
  ] = await Promise.all([
    import('./tools/queue-summary.js'),
    import('./tools/queue-details.js'),
    import('./tools/pr-eligibility.js'),
    import('./tools/queue-freezes.js'),
    import('./tools/set-queue-state.js'),
    import('./tools/replay-pr.js'),
  ]);
  TOOL_DEFS.push(queueSummaryTool, queueDetailsTool, prEligibilityTool, queueFreezesTool, setQueueStateTool, replayPrTool);
  return TOOL_DEFS;
}

function buildInputSchema(def: ToolDefinition) {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const [key, field] of Object.entries(def.inputSchema)) {
    const base = field.type === 'number'
      ? z.number().describe(field.description)
      : z.string().describe(field.description);
    shape[key] = field.required ? base : base.optional();
  }
  return shape;
}

export async function createTestServer(): Promise<TestServer> {
  const tools = await loadTools();
  const cache = createCache();
  const client = createStubClient(cache);

  return {
    async invokeWithRole(role: string | undefined, toolName: string, args: Record<string, unknown> = {}): Promise<RoleGateResult> {
      const gateResult = gate(role, toolName as ToolName);

      if (gateResult === 'role-unrecognised') {
        return { type: 'role-unrecognised', role: role ?? '', tool: toolName };
      }
      if (gateResult === 'role-refused') {
        return { type: 'role-refused', role: role ?? '', tool: toolName };
      }

      const toolDef = tools.find((t) => t.name === toolName);
      if (!toolDef) {
        return { type: 'role-refused', role: role ?? '', tool: toolName };
      }

      try {
        const result = await toolDef.handler(args, client);
        return { type: 'allow', result };
      } catch (err) {
        const envelope: ErrorEnvelope = {
          error: err instanceof Error ? err.message : String(err),
          details: err instanceof Error ? err.stack : undefined,
        };
        const redacted = redactErrorEnvelope(envelope);
        return { type: 'allow', result: redacted };
      }
    },
  };
}

function createStubClient(cache: ReturnType<typeof createCache>): MergifyClient {
  return {
    async getQueueSummary() {
      return cache.getOrSet('queue_summary', 30_000, async () => ({ queues: [] }));
    },
    async getQueueDetails(pr: number) {
      return { pr, position: null, queue: null };
    },
    async checkPrEligibility(pr: number) {
      return { pr, eligible: false, reasons: [] };
    },
    async listQueueFreezes() {
      return cache.getOrSet('queue_freezes', 60_000, async () => ({ freezes: [] }));
    },
    async setQueueState(state: string, reason: string) {
      return { state, reason, applied: true };
    },
    async replayPr(pr: number, reason: string) {
      return { pr, reason, replayed: true };
    },
  };
}

export async function createServer(role?: string): Promise<McpServer> {
  checkEnvLeakGuard();
  const tools = await loadTools();
  const cache = createCache();
  const client = createMergifyClient(cache);
  const server = new McpServer({ name: 'mergify-mcp', version: '0.1.0' });
  const effectiveRole = role ?? process.env['MERGIFY_MCP_ROLE'];

  for (const toolDef of tools) {
    const inputSchema = buildInputSchema(toolDef);
    server.registerTool(
      toolDef.name,
      {
        description: toolDef.description,
        inputSchema: Object.keys(inputSchema).length > 0 ? inputSchema : undefined,
      },
      async (args) => {
        const gateResult = gate(effectiveRole, toolDef.name);

        if (gateResult === 'role-unrecognised') {
          const envelope = redactErrorEnvelope({
            error: `role-unrecognised: MERGIFY_MCP_ROLE="${effectiveRole ?? ''}" is not a recognised role`,
            code: 'role-unrecognised',
          });
          return { content: [{ type: 'text', text: JSON.stringify(envelope) }], isError: true };
        }

        if (gateResult === 'role-refused') {
          const envelope = redactErrorEnvelope({
            error: `role-refused: role "${effectiveRole}" cannot invoke tool "${toolDef.name}"`,
            code: 'role-refused',
          });
          return { content: [{ type: 'text', text: JSON.stringify(envelope) }], isError: true };
        }

        try {
          const result = await toolDef.handler(args as Record<string, unknown>, client);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        } catch (err) {
          const envelope = redactErrorEnvelope({
            error: err instanceof Error ? err.message : String(err),
            details: err instanceof Error ? err.stack : undefined,
          });
          return { content: [{ type: 'text', text: JSON.stringify(envelope) }], isError: true };
        }
      },
    );
  }

  return server;
}

export async function main(): Promise<void> {
  const server = await createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch(console.error);
