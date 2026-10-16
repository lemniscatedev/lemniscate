import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";

export interface RateLimitOptions {
  /** Requests allowed per client per window; 0 disables the limiter. */
  readonly limit: number;
  readonly windowMs: number;
  /** Header carrying the client IP set by the fronting proxy (Cloudflare). */
  readonly clientIpHeader: string;
  readonly maxClients?: number;
  readonly now?: () => number;
}

/** The client address: the proxy-supplied header first (the API is only
 * reachable through Cloudflare Tunnel), then the first X-Forwarded-For hop,
 * then the socket peer. */
export function clientIp(context: Context, header: string): string {
  const fromHeader = header ? context.req.header(header)?.trim() : undefined;
  if (fromHeader) return fromHeader.slice(0, 64);
  const forwarded = context.req.header("x-forwarded-for")?.split(",")[0]?.trim();
  if (forwarded) return forwarded.slice(0, 64);
  try { return getConnInfo(context).remote.address ?? "unknown"; }
  catch { return "unknown"; }
}

/** Fixed-window, in-memory, per-IP request limiter. */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const now = options.now ?? Date.now;
  const maxClients = options.maxClients ?? 50_000;
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = now();

  function sweep(at: number) {
    for (const [key, window] of windows) if (at - window.start >= options.windowMs) windows.delete(key);
    lastSweep = at;
  }

  return async (context, next) => {
    if (options.limit <= 0 || context.req.method === "OPTIONS") return next();
    const at = now();
    if (at - lastSweep >= options.windowMs || windows.size >= maxClients) sweep(at);
    // Under a flood of distinct addresses, drop the oldest tracked client
    // rather than grow without bound.
    if (windows.size >= maxClients) {
      const oldest = windows.keys().next().value;
      if (oldest !== undefined) windows.delete(oldest);
    }
    const key = clientIp(context, options.clientIpHeader);
    let window = windows.get(key);
    if (!window || at - window.start >= options.windowMs) {
      window = { start: at, count: 0 };
      windows.delete(key);
      windows.set(key, window);
    }
    window.count += 1;
    if (window.count > options.limit) {
      const retryAfter = Math.max(1, Math.ceil((window.start + options.windowMs - at) / 1000));
      context.header("Retry-After", String(retryAfter));
      return context.json({ error: "RATE_LIMITED", message: "Too many requests." }, 429);
    }
    return next();
  };
}
