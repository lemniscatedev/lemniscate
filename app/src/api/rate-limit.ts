import type { Context, MiddlewareHandler } from "hono";
import { getConnInfo } from "hono/bun";
import { isIP } from "node:net";

export interface RateLimitOptions {
  /** Requests allowed per client per window; 0 disables the limiter. */
  readonly limit: number;
  readonly windowMs: number;
  /** Header carrying the client IP set by the fronting proxy (Cloudflare). */
  readonly clientIpHeader: string;
  readonly maxClients?: number;
  readonly now?: () => number;
  /** Per-wallet keys for write routes: the wallets a request acts for (read from its JSON body). R3-07: the body is not
   * authenticated, so a wallet counter is kept per (client, wallet): a client that names many wallets, or one wallet many
   * times, uses up its own limits, and requests that name a wallet from other clients never spend that wallet's own client's
   * budget. */
  readonly walletKeys?: (context: Context) => Promise<readonly string[]>;
  /** Requests allowed per wallet per window; defaults to `limit`. */
  readonly walletLimit?: number;
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

/** Expands an IPv6 literal to its eight 16-bit groups, or undefined when it is not one. */
function ipv6Groups(address: string): number[] | undefined {
  let text = address.split("%")[0]!;
  // An embedded dotted IPv4 tail (::ffff:1.2.3.4) is two groups.
  const dotted = /(\d+\.\d+\.\d+\.\d+)$/.exec(text);
  if (dotted) {
    const octets = dotted[1]!.split(".").map(Number);
    if (octets.some((octet) => octet > 255)) return undefined;
    text = text.slice(0, -dotted[1]!.length) + ((octets[0]! << 8) | octets[1]!).toString(16) + ":" + ((octets[2]! << 8) | octets[3]!).toString(16);
  }
  const halves = text.split("::");
  if (halves.length > 2) return undefined;
  const head = halves[0] ? halves[0].split(":") : [];
  const tail = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - head.length - tail.length;
  if (halves.length === 1 ? missing !== 0 : missing < 1) return undefined;
  const groups = [...head, ...Array<string>(halves.length === 2 ? missing : 0).fill("0"), ...tail];
  if (groups.length !== 8 || groups.some((group) => !/^[0-9a-fA-F]{1,4}$/.test(group))) return undefined;
  return groups.map((group) => parseInt(group, 16));
}

/** The key a client is counted under: an IPv4 address by itself, an IPv6 address by its /64 (a single host or tenant
 * normally owns the whole /64, so keying on the full address lets it rotate through 2^64 identities). An IPv4-mapped
 * IPv6 address counts as its IPv4 address. Anything that is not an IP literal is used as given. */
export function rateLimitKey(address: string): string {
  const trimmed = address.trim().toLowerCase();
  if (isIP(trimmed) === 4) return trimmed;
  if (isIP(trimmed.split("%")[0]!) === 6) {
    const groups = ipv6Groups(trimmed);
    if (!groups) return trimmed;
    if (groups.slice(0, 5).every((group) => group === 0) && groups[5] === 0xffff) {
      return `${groups[6]! >> 8}.${groups[6]! & 255}.${groups[7]! >> 8}.${groups[7]! & 255}`;
    }
    return `${groups.slice(0, 4).map((group) => group.toString(16)).join(":")}::/64`;
  }
  return trimmed;
}

const WALLET = /^0x[0-9a-fA-F]{40}$/;

/** Wallet addresses named by a JSON body: the given top-level fields and `userOp.sender`. Never throws. */
export function walletsFromBody(fields: readonly string[] = ["address", "account", "owner"]): (context: Context) => Promise<readonly string[]> {
  return async (context) => {
    let body: unknown;
    try { body = await context.req.raw.clone().json(); } catch { return []; }
    if (!body || typeof body !== "object") return [];
    const record = body as Record<string, unknown>;
    const found = new Set<string>();
    const take = (value: unknown) => { if (typeof value === "string" && WALLET.test(value)) found.add(`wallet:${value.toLowerCase()}`); };
    for (const field of fields) take(record[field]);
    const userOp = record.userOp;
    if (userOp && typeof userOp === "object") take((userOp as Record<string, unknown>).sender);
    return [...found];
  };
}

/** Fixed-window, in-memory request limiter: per client (IPv4 address or IPv6 /64) and, when configured, per (client, wallet). */
export function rateLimit(options: RateLimitOptions): MiddlewareHandler {
  const now = options.now ?? Date.now;
  const maxClients = options.maxClients ?? 50_000;
  const walletLimit = options.walletLimit ?? options.limit;
  const windows = new Map<string, { start: number; count: number }>();
  let lastSweep = now();

  function sweep(at: number) {
    for (const [key, window] of windows) if (at - window.start >= options.windowMs) windows.delete(key);
    lastSweep = at;
  }

  /** Counts one request under `key`; returns the seconds to wait when it is over `limit`. */
  function hit(key: string, limit: number, at: number): number | undefined {
    let window = windows.get(key);
    if (!window || at - window.start >= options.windowMs) {
      // Under a flood of distinct keys, drop the oldest tracked one rather than grow without bound.
      if (!window && windows.size >= maxClients) {
        const oldest = windows.keys().next().value;
        if (oldest !== undefined) windows.delete(oldest);
      }
      window = { start: at, count: 0 };
      windows.delete(key);
      windows.set(key, window);
    }
    window.count += 1;
    if (window.count > limit) return Math.max(1, Math.ceil((window.start + options.windowMs - at) / 1000));
    return undefined;
  }

  return async (context, next) => {
    if (options.limit <= 0 || context.req.method === "OPTIONS") return next();
    const at = now();
    if (at - lastSweep >= options.windowMs || windows.size >= maxClients) sweep(at);
    const client = rateLimitKey(clientIp(context, options.clientIpHeader));
    const keys: { key: string; limit: number }[] = [{ key: `ip:${client}`, limit: options.limit }];
    if (options.walletKeys) {
      // R3-07: never a bare wallet key. Anyone can name any wallet in a body, so a counter shared by every client would let a
      // stranger fill a holder's bucket and lock the holder out of quotes, sells, builds and relays.
      for (const wallet of (await options.walletKeys(context)).slice(0, 4)) keys.push({ key: `${wallet}@${client}`, limit: walletLimit });
    }
    let retryAfter: number | undefined;
    for (const { key, limit } of keys) {
      const wait = hit(key, limit, at);
      if (wait !== undefined) retryAfter = Math.max(retryAfter ?? 0, wait);
    }
    if (retryAfter !== undefined) {
      context.header("Retry-After", String(retryAfter));
      return context.json({ error: "RATE_LIMITED", message: "Too many requests." }, 429);
    }
    return next();
  };
}
