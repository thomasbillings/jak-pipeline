import { describe, it, expect, beforeEach, vi } from 'vitest';

// These tests verify role-gate behaviour per acceptance criteria a3-a7.
// They import createServer() which does not exist yet — all tests FAIL red.

const ALL_TOOLS = [
  'mergify_get_queue_summary',
  'mergify_get_queue_details',
  'mergify_check_pr_eligibility',
  'mergify_list_queue_freezes',
  'mergify_set_queue_state',
  'mergify_replay_pr',
] as const;

const READ_TOOLS = [
  'mergify_get_queue_summary',
  'mergify_get_queue_details',
  'mergify_check_pr_eligibility',
  'mergify_list_queue_freezes',
] as const;

const MUTATE_TOOLS = [
  'mergify_set_queue_state',
  'mergify_replay_pr',
] as const;

// Role-gate is enforced by calling the server's invokeToolWithRole helper.
// The helper sets MERGIFY_MCP_ROLE in the environment before dispatching.
// createServer returns the server instance + a test helper for role-gating.
type RoleGateResult =
  | { type: 'allow'; result: unknown }
  | { type: 'role-refused'; role: string; tool: string }
  | { type: 'role-unrecognised'; role: string; tool: string };

interface TestServer {
  invokeWithRole(role: string | undefined, toolName: string, args?: Record<string, unknown>): Promise<RoleGateResult>;
}

// Forward declaration — will be resolved when src/server.ts exists
async function getTestServer(): Promise<TestServer> {
  const { createTestServer } = await import('../src/server.js');
  return createTestServer();
}

describe('role-gating', () => {
  describe('scrum-master can invoke every tool (a3)', () => {
    it('allows all 6 tools for scrum-master role', async () => {
      const server = await getTestServer();
      for (const tool of ALL_TOOLS) {
        const result = await server.invokeWithRole('scrum-master', tool, { pr: 1, state: 'locked', reason: 'test' });
        expect(result.type).toBe('allow');
      }
    });
  });

  describe('pr-reviewer is read-only (a4)', () => {
    it('allows read tools for pr-reviewer', async () => {
      const server = await getTestServer();
      for (const tool of READ_TOOLS) {
        const result = await server.invokeWithRole('pr-reviewer', tool, { pr: 1 });
        expect(result.type).toBe('allow');
      }
    });

    it('refuses set_queue_state for pr-reviewer', async () => {
      const server = await getTestServer();
      const result = await server.invokeWithRole('pr-reviewer', 'mergify_set_queue_state', { state: 'locked', reason: 'test' });
      expect(result.type).toBe('role-refused');
    });

    it('refuses replay_pr for pr-reviewer', async () => {
      const server = await getTestServer();
      const result = await server.invokeWithRole('pr-reviewer', 'mergify_replay_pr', { pr: 1, reason: 'test' });
      expect(result.type).toBe('role-refused');
    });
  });

  describe('dev-agent has limited read (a5)', () => {
    it('allows summary, details, eligibility for dev-agent', async () => {
      const server = await getTestServer();
      for (const tool of ['mergify_get_queue_summary', 'mergify_get_queue_details', 'mergify_check_pr_eligibility'] as const) {
        const result = await server.invokeWithRole('dev-agent', tool, { pr: 1 });
        expect(result.type).toBe('allow');
      }
    });

    it('refuses list_queue_freezes for dev-agent', async () => {
      const server = await getTestServer();
      const result = await server.invokeWithRole('dev-agent', 'mergify_list_queue_freezes', {});
      expect(result.type).toBe('role-refused');
    });

    it('refuses set_queue_state for dev-agent', async () => {
      const server = await getTestServer();
      const result = await server.invokeWithRole('dev-agent', 'mergify_set_queue_state', { state: 'locked', reason: 'test' });
      expect(result.type).toBe('role-refused');
    });

    it('refuses replay_pr for dev-agent', async () => {
      const server = await getTestServer();
      const result = await server.invokeWithRole('dev-agent', 'mergify_replay_pr', { pr: 1, reason: 'test' });
      expect(result.type).toBe('role-refused');
    });
  });

  describe('planner can only get summary (a6)', () => {
    it('allows queue_summary for planner', async () => {
      const server = await getTestServer();
      const result = await server.invokeWithRole('planner', 'mergify_get_queue_summary', {});
      expect(result.type).toBe('allow');
    });

    it('refuses the other 5 tools for planner', async () => {
      const server = await getTestServer();
      const restricted = [
        'mergify_get_queue_details',
        'mergify_check_pr_eligibility',
        'mergify_list_queue_freezes',
        'mergify_set_queue_state',
        'mergify_replay_pr',
      ] as const;
      for (const tool of restricted) {
        const result = await server.invokeWithRole('planner', tool, { pr: 1, state: 'locked', reason: 'test' });
        expect(result.type).toBe('role-refused');
      }
    });
  });

  describe('unrecognised role refuses every tool (a7)', () => {
    it('refuses all tools for unknown role string', async () => {
      const server = await getTestServer();
      for (const tool of ALL_TOOLS) {
        const result = await server.invokeWithRole('unknown-role', tool, { pr: 1, state: 'locked', reason: 'test' });
        expect(result.type).toBe('role-unrecognised');
      }
    });

    it('refuses all tools when MERGIFY_MCP_ROLE is absent', async () => {
      const server = await getTestServer();
      for (const tool of ALL_TOOLS) {
        const result = await server.invokeWithRole(undefined, tool, { pr: 1, state: 'locked', reason: 'test' });
        expect(result.type).toBe('role-unrecognised');
      }
    });
  });
});
