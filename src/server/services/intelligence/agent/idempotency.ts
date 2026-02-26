interface CacheEntry<T> {
  expiresAt: number;
  promise: Promise<T>;
}

const TTL_MS = 5 * 60 * 1000;
const cache = new Map<string, CacheEntry<unknown>>();

function pruneExpired(): void {
  const now = Date.now();
  for (const [key, entry] of cache.entries()) {
    if (entry.expiresAt <= now) {
      cache.delete(key);
    }
  }
}

export async function runIdempotent<T>(
  key: string,
  operation: () => Promise<T>,
): Promise<{ reused: boolean; value: T }> {
  pruneExpired();
  const existing = cache.get(key) as CacheEntry<T> | undefined;
  if (existing) {
    return {
      reused: true,
      value: await existing.promise,
    };
  }

  const promise = operation();
  cache.set(key, {
    expiresAt: Date.now() + TTL_MS,
    promise,
  });

  try {
    const value = await promise;
    return {
      reused: false,
      value,
    };
  } catch (error) {
    cache.delete(key);
    throw error;
  }
}
