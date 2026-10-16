/** Fixed-window limiter keyed by caller (the agent address for stdio, the token or IP for HTTP). */
export function createKeyedLimiter(options: { limit: number; windowMs: number; now?: () => number; maxKeys?: number }) {
  const now = options.now ?? Date.now;
  const maxKeys = options.maxKeys ?? 10_000;
  const windows = new Map<string, { start: number; count: number }>();
  return {
    /** True when the call may proceed; otherwise retryAfterSeconds says when. */
    take(key: string): { ok: true } | { ok: false; retryAfterSeconds: number } {
      if (options.limit <= 0) return { ok: true };
      const at = now();
      let window = windows.get(key);
      if (!window || at - window.start >= options.windowMs) {
        if (windows.size >= maxKeys) {
          for (const [k, w] of windows) if (at - w.start >= options.windowMs) windows.delete(k);
          if (windows.size >= maxKeys) { const oldest = windows.keys().next().value; if (oldest !== undefined) windows.delete(oldest); }
        }
        window = { start: at, count: 0 };
        windows.delete(key);
        windows.set(key, window);
      }
      window.count += 1;
      if (window.count > options.limit) {
        return { ok: false, retryAfterSeconds: Math.max(1, Math.ceil((window.start + options.windowMs - at) / 1000)) };
      }
      return { ok: true };
    },
  };
}
export type KeyedLimiter = ReturnType<typeof createKeyedLimiter>;
