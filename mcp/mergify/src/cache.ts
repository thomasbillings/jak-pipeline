interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

export interface Cache {
  getOrSet<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T>;
  clear(): void;
}

export function createCache(): Cache {
  const store = new Map<string, CacheEntry>();

  return {
    async getOrSet<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
      const now = Date.now();
      const entry = store.get(key);
      if (entry && entry.expiresAt > now) {
        return entry.value as T;
      }
      const value = await fn();
      store.set(key, { value, expiresAt: now + ttlMs });
      return value;
    },
    clear() {
      store.clear();
    },
  };
}
