interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class TtlCache {
  private readonly entries = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();

  async getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const cached = this.entries.get(key) as CacheEntry<T> | undefined;
    if (cached && cached.expiresAt > now) return cached.value;

    const running = this.inFlight.get(key) as Promise<T> | undefined;
    if (running) return running;

    const pending = load()
      .then((value) => {
        this.entries.set(key, { value, expiresAt: Date.now() + Math.max(0, ttlMs) });
        return value;
      })
      .finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, pending);
    return pending;
  }

  clear(): void {
    this.entries.clear();
    this.inFlight.clear();
  }
}

