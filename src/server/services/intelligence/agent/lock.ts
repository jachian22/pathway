const sessionChains = new Map<string, Promise<void>>();

export async function withSessionLock<T>(
  sessionId: string,
  fn: (waitMs: number) => Promise<T>,
): Promise<T> {
  const previous = sessionChains.get(sessionId) ?? Promise.resolve();
  let release!: () => void;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });

  sessionChains.set(
    sessionId,
    previous
      .catch(() => undefined)
      .then(() => current)
      .finally(() => {
        if (sessionChains.get(sessionId) === current) {
          sessionChains.delete(sessionId);
        }
      }),
  );

  const waitStarted = Date.now();
  await previous.catch(() => undefined);
  const waitMs = Date.now() - waitStarted;

  try {
    return await fn(waitMs);
  } finally {
    release();
  }
}
