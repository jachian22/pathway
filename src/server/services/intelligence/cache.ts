type CacheEntry<T> = {
  value: T;
  expiresAtMs: number;
  fetchedAtMs: number;
};

const inMemoryCache = new Map<string, CacheEntry<unknown>>();

export function readCache<T>(key: string): { value: T; fetchedAtMs: number } | null {
  const item = inMemoryCache.get(key) as CacheEntry<T> | undefined;
  if (!item) return null;
  if (item.expiresAtMs < Date.now()) {
    inMemoryCache.delete(key);
    return null;
  }
  return {
    value: item.value,
    fetchedAtMs: item.fetchedAtMs,
  };
}

export function writeCache<T>(key: string, value: T, ttlMs: number): void {
  inMemoryCache.set(key, {
    value,
    fetchedAtMs: Date.now(),
    expiresAtMs: Date.now() + ttlMs,
  });
}
