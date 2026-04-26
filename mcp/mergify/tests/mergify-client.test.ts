import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCache } from '../src/cache.js';

// Mock global fetch to test the real Mergify client without live API calls
describe('mergify-client', () => {
  const originalEnv = { ...process.env };

  beforeEach(() => {
    process.env['MERGIFY_API_KEY'] = 'mrg_test_FAKEKEY';
    process.env['MERGIFY_ORG'] = 'test-org';
    process.env['GITHUB_TOKEN'] = 'ghp_FAKETOKEN';
  });

  afterEach(() => {
    process.env = { ...originalEnv };
    vi.restoreAllMocks();
  });

  it('creates a client when env vars are set', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ queues: [] }),
    }));

    const cache = createCache();
    const { createMergifyClient } = await import('../src/mergify-client.js');
    const client = createMergifyClient(cache);
    expect(client).toBeDefined();
  });

  it('getQueueSummary calls /queues endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ queues: [{ name: 'feature' }] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const cache = createCache();
    const { createMergifyClient } = await import('../src/mergify-client.js');
    const client = createMergifyClient(cache);
    const result = await client.getQueueSummary() as { queues: unknown[] };

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/queues'),
      expect.objectContaining({ headers: expect.objectContaining({ Authorization: 'Bearer mrg_test_FAKEKEY' }) }),
    );
    expect(result.queues).toHaveLength(1);
  });

  it('getQueueDetails calls /queue/pulls/:pr endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pr: 42, position: 1 }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const cache = createCache();
    const { createMergifyClient } = await import('../src/mergify-client.js');
    const client = createMergifyClient(cache);
    const result = await client.getQueueDetails(42) as { pr: number };

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/queue/pulls/42'),
      expect.anything(),
    );
    expect(result.pr).toBe(42);
  });

  it('checkPrEligibility calls /queue/pulls/:pr/eligibility', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ pr: 10, eligible: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const cache = createCache();
    const { createMergifyClient } = await import('../src/mergify-client.js');
    const client = createMergifyClient(cache);
    await client.checkPrEligibility(10);

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/queue/pulls/10/eligibility'),
      expect.anything(),
    );
  });

  it('listQueueFreezes calls /queue/freeze endpoint', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ freezes: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const cache = createCache();
    const { createMergifyClient } = await import('../src/mergify-client.js');
    const client = createMergifyClient(cache);
    await client.listQueueFreezes();

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/queue/freeze'),
      expect.anything(),
    );
  });

  it('setQueueState PUT on locked state', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ applied: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const cache = createCache();
    const { createMergifyClient } = await import('../src/mergify-client.js');
    const client = createMergifyClient(cache);
    await client.setQueueState('locked', 'maintenance');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/queue/freeze'),
      expect.objectContaining({ method: 'PUT' }),
    );
  });

  it('setQueueState DELETE on unlocked state', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ applied: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const cache = createCache();
    const { createMergifyClient } = await import('../src/mergify-client.js');
    const client = createMergifyClient(cache);
    await client.setQueueState('unlocked', 'done');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/queue/freeze'),
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('replayPr calls /queue/pulls/:pr/replay with POST', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ replayed: true }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const cache = createCache();
    const { createMergifyClient } = await import('../src/mergify-client.js');
    const client = createMergifyClient(cache);
    await client.replayPr(99, 'retry');

    expect(mockFetch).toHaveBeenCalledWith(
      expect.stringContaining('/queue/pulls/99/replay'),
      expect.objectContaining({ method: 'POST' }),
    );
  });

  it('throws on non-ok HTTP response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 403,
      text: async () => 'Forbidden',
    });
    vi.stubGlobal('fetch', mockFetch);

    const cache = createCache();
    const { createMergifyClient } = await import('../src/mergify-client.js');
    const client = createMergifyClient(cache);

    await expect(client.getQueueDetails(1)).rejects.toThrow('403');
  });

  it('throws when MERGIFY_API_KEY is missing', async () => {
    delete process.env['MERGIFY_API_KEY'];

    const cache = createCache();
    const { createMergifyClient } = await import('../src/mergify-client.js');

    expect(() => createMergifyClient(cache)).toThrow('MERGIFY_API_KEY');
  });

  it('throws on invalid setQueueState state value', async () => {
    vi.stubGlobal('fetch', vi.fn());
    const cache = createCache();
    const { createMergifyClient } = await import('../src/mergify-client.js');
    const client = createMergifyClient(cache);
    await expect(client.setQueueState('paused', 'typo')).rejects.toThrow('invalid state');
  });

  it('setQueueState clears cache after mutation', async () => {
    const mockFetch = vi.fn()
      .mockResolvedValue({ ok: true, json: async () => ({ applied: true }) });
    vi.stubGlobal('fetch', mockFetch);

    const cache = createCache();
    const summarySpy = vi.fn().mockResolvedValue({ queues: [] });
    await cache.getOrSet('queue_summary', 30_000, summarySpy);
    expect(summarySpy).toHaveBeenCalledTimes(1);

    const { createMergifyClient } = await import('../src/mergify-client.js');
    const client = createMergifyClient(cache);
    await client.setQueueState('locked', 'test');

    // After setQueueState clears cache, next call should re-fetch
    await cache.getOrSet('queue_summary', 30_000, summarySpy);
    expect(summarySpy).toHaveBeenCalledTimes(2);
  });

  it('getQueueSummary uses cache on second call', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ queues: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const cache = createCache();
    const { createMergifyClient } = await import('../src/mergify-client.js');
    const client = createMergifyClient(cache);
    await client.getQueueSummary();
    await client.getQueueSummary();

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });
});
