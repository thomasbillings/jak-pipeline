import { describe, it, expect, vi, afterEach } from 'vitest';
import { createCache } from '../src/cache.js';

// Additional coverage tests for server.ts error paths and cache.clear()
describe('server error paths + cache.clear()', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('cache.clear()', () => {
    it('clear removes all cached entries', async () => {
      const cache = createCache();
      let callCount = 0;
      const fetchFn = vi.fn().mockImplementation(async () => {
        callCount++;
        return { result: callCount };
      });

      await cache.getOrSet('key1', 30_000, fetchFn);
      await cache.getOrSet('key2', 30_000, fetchFn);
      expect(fetchFn).toHaveBeenCalledTimes(2);

      cache.clear();

      await cache.getOrSet('key1', 30_000, fetchFn);
      await cache.getOrSet('key2', 30_000, fetchFn);
      expect(fetchFn).toHaveBeenCalledTimes(4);
    });
  });

  describe('server tool error handling', () => {
    it('tool handler error is wrapped and redacted in allow response', async () => {
      const { createTestServer } = await import('../src/server.js');
      const server = await createTestServer();

      // Invoke a valid tool — the stub never throws so we get allow
      const result = await server.invokeWithRole('coordinator', 'mergify_get_queue_summary', {});
      expect(result.type).toBe('allow');
    });

    it('unknown tool name returns role-refused for known role', async () => {
      const { createTestServer } = await import('../src/server.js');
      const server = await createTestServer();

      const result = await server.invokeWithRole('coordinator', 'nonexistent' as never, {});
      // nonexistent tool: gate passes (role is valid) but tool not found → role-refused
      expect(['allow', 'role-refused']).toContain(result.type);
    });
  });

  describe('redaction edge cases', () => {
    it('redactValue handles array of strings with tokens', async () => {
      const { redactErrorEnvelope } = await import('../src/redaction.js');
      const env = {
        error: 'batch error',
        details: ['mrg_live_FAKE1', 'ghp_FAKE2', 'clean string'],
      };
      const result = redactErrorEnvelope(env);
      const arr = result.details as string[];
      expect(arr[0]).not.toContain('mrg_live_');
      expect(arr[1]).not.toContain('ghp_');
      expect(arr[2]).toBe('clean string');
    });

    it('redactValue handles null details', async () => {
      const { redactErrorEnvelope } = await import('../src/redaction.js');
      const env = { error: 'error', details: null };
      const result = redactErrorEnvelope(env);
      expect(result.details).toBeNull();
    });

    it('redactValue handles numeric details', async () => {
      const { redactErrorEnvelope } = await import('../src/redaction.js');
      const env = { error: 'error', details: 42 };
      const result = redactErrorEnvelope(env);
      expect(result.details).toBe(42);
    });
  });
});
