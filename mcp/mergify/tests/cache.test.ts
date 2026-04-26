import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createCache } from '../src/cache.js';

describe('cache layer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe('queue summary cached for 30s (a13)', () => {
    it('calls the fetch function only once within the TTL', async () => {
      const cache = createCache();
      const fetchFn = vi.fn().mockResolvedValue({ queues: [] });

      // First call — cache miss
      await cache.getOrSet('queue_summary', 30_000, fetchFn);
      // Second call within TTL — cache hit
      await cache.getOrSet('queue_summary', 30_000, fetchFn);

      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after TTL expires', async () => {
      const cache = createCache();
      const fetchFn = vi.fn().mockResolvedValue({ queues: [] });

      await cache.getOrSet('queue_summary', 30_000, fetchFn);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      // Advance time past the 30s TTL
      vi.advanceTimersByTime(30_001);

      await cache.getOrSet('queue_summary', 30_000, fetchFn);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });

    it('returns cached value within TTL', async () => {
      const cache = createCache();
      const expected = { queues: [{ name: 'feature' }] };
      const fetchFn = vi.fn().mockResolvedValue(expected);

      const first = await cache.getOrSet('queue_summary', 30_000, fetchFn);
      vi.advanceTimersByTime(15_000); // halfway through TTL
      const second = await cache.getOrSet('queue_summary', 30_000, fetchFn);

      expect(first).toEqual(expected);
      expect(second).toEqual(expected);
      expect(fetchFn).toHaveBeenCalledTimes(1);
    });
  });

  describe('list queue freezes cached for 60s (a14)', () => {
    it('calls the fetch function only once within the 60s TTL', async () => {
      const cache = createCache();
      const fetchFn = vi.fn().mockResolvedValue({ freezes: [] });

      await cache.getOrSet('queue_freezes', 60_000, fetchFn);
      await cache.getOrSet('queue_freezes', 60_000, fetchFn);

      expect(fetchFn).toHaveBeenCalledTimes(1);
    });

    it('re-fetches after 60s TTL expires', async () => {
      const cache = createCache();
      const fetchFn = vi.fn().mockResolvedValue({ freezes: [] });

      await cache.getOrSet('queue_freezes', 60_000, fetchFn);
      expect(fetchFn).toHaveBeenCalledTimes(1);

      vi.advanceTimersByTime(60_001);

      await cache.getOrSet('queue_freezes', 60_000, fetchFn);
      expect(fetchFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('cache isolation', () => {
    it('separate keys do not share cache entries', async () => {
      const cache = createCache();
      const summaryFn = vi.fn().mockResolvedValue({ queues: [] });
      const freezeFn = vi.fn().mockResolvedValue({ freezes: [] });

      await cache.getOrSet('queue_summary', 30_000, summaryFn);
      await cache.getOrSet('queue_freezes', 60_000, freezeFn);
      await cache.getOrSet('queue_summary', 30_000, summaryFn);
      await cache.getOrSet('queue_freezes', 60_000, freezeFn);

      expect(summaryFn).toHaveBeenCalledTimes(1);
      expect(freezeFn).toHaveBeenCalledTimes(1);
    });
  });
});
