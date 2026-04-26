import { describe, it, expect } from 'vitest';

const EXPECTED_TOOLS = [
  'mergify_get_queue_summary',
  'mergify_get_queue_details',
  'mergify_check_pr_eligibility',
  'mergify_list_queue_freezes',
  'mergify_set_queue_state',
  'mergify_replay_pr',
] as const;

describe('server shape (a1, a2)', () => {
  describe('a1: package structure', () => {
    it('package.json has required scripts', async () => {
      const { default: pkg } = await import('../package.json', { with: { type: 'json' } });
      expect(pkg.scripts?.build).toBeDefined();
      expect(pkg.scripts?.test).toBeDefined();
    });
  });

  describe('a2: all 6 tools registered with correct names', () => {
    it('createTestServer exposes all 6 tool names', async () => {
      const { createTestServer } = await import('../src/server.js');
      const server = await createTestServer();

      // Verify all 6 tools can be invoked (coordinator role) — proves registration
      for (const toolName of EXPECTED_TOOLS) {
        const result = await server.invokeWithRole('coordinator', toolName, { pr: 1, state: 'locked', reason: 'test' });
        expect(result.type, `tool ${toolName} should be registered`).toBe('allow');
      }
    });

    it('does not include unregistered tools', async () => {
      const { createTestServer } = await import('../src/server.js');
      const server = await createTestServer();
      const result = await server.invokeWithRole('coordinator', 'nonexistent_tool' as never, {});
      // nonexistent tool = role-refused (caught at gate level as unknown tool)
      expect(['role-refused', 'role-unrecognised']).toContain(result.type);
    });

    it('mergify_get_queue_summary accepts no required args', async () => {
      const { createTestServer } = await import('../src/server.js');
      const server = await createTestServer();
      const result = await server.invokeWithRole('coordinator', 'mergify_get_queue_summary', {});
      expect(result.type).toBe('allow');
    });

    it('mergify_get_queue_details accepts pr argument', async () => {
      const { createTestServer } = await import('../src/server.js');
      const server = await createTestServer();
      const result = await server.invokeWithRole('coordinator', 'mergify_get_queue_details', { pr: 42 });
      expect(result.type).toBe('allow');
      expect((result as { type: 'allow'; result: unknown }).result).toMatchObject({ pr: 42 });
    });

    it('mergify_check_pr_eligibility accepts pr argument', async () => {
      const { createTestServer } = await import('../src/server.js');
      const server = await createTestServer();
      const result = await server.invokeWithRole('coordinator', 'mergify_check_pr_eligibility', { pr: 42 });
      expect(result.type).toBe('allow');
    });

    it('mergify_list_queue_freezes accepts no required args', async () => {
      const { createTestServer } = await import('../src/server.js');
      const server = await createTestServer();
      const result = await server.invokeWithRole('coordinator', 'mergify_list_queue_freezes', {});
      expect(result.type).toBe('allow');
    });

    it('mergify_set_queue_state accepts state and reason', async () => {
      const { createTestServer } = await import('../src/server.js');
      const server = await createTestServer();
      const result = await server.invokeWithRole('coordinator', 'mergify_set_queue_state', { state: 'locked', reason: 'maintenance' });
      expect(result.type).toBe('allow');
    });

    it('mergify_replay_pr accepts pr and reason', async () => {
      const { createTestServer } = await import('../src/server.js');
      const server = await createTestServer();
      const result = await server.invokeWithRole('coordinator', 'mergify_replay_pr', { pr: 99, reason: 'retry' });
      expect(result.type).toBe('allow');
    });
  });
});
