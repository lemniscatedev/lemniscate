// Caching JSON-RPC proxy in front of the free public RPC, for the anvil mainnet fork (crypto-local-testing section 1).
// Free public RPCs keep only ~10-15 minutes of state history: once the pinned fork block falls out of that window, every
// storage slot anvil has not fetched yet fails. This proxy answers every block-pinned read from a disk cache and only asks
// upstream for slots it has never seen, so a fork restarted hours later still works for everything touched before.
//
//   bun scripts/fork/rpc-cache.ts --port 9545 --upstream https://rpc.mainnet.chain.robinhood.com --cache .fork/rpc-cache.jsonl
//
// Never sends a transaction upstream: eth_sendRawTransaction and eth_sendTransaction are refused.
import { appendFileSync, existsSync, readFileSync } from "node:fs";

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface RpcRequest { jsonrpc?: string; id?: Json; method: string; params?: Json[] }
interface RpcResponse { jsonrpc: "2.0"; id: Json; result?: Json; error?: { code: number; message: string; data?: Json } }

/** Methods whose answer never changes once the block parameter is a fixed number or hash. */
const PINNED_BLOCK_ARG: Record<string, number> = {
  eth_getStorageAt: 2,
  eth_getCode: 1,
  eth_getBalance: 1,
  eth_getTransactionCount: 1,
  eth_call: 1,
  eth_getProof: 2,
  eth_getBlockByNumber: 0,
};
/** Methods whose answer is fixed whatever the params are (when the result is not null). */
const IMMUTABLE = new Set(["eth_chainId", "net_version", "eth_getBlockByHash", "eth_getTransactionByHash", "eth_getTransactionReceipt"]);
const REFUSED = new Set(["eth_sendRawTransaction", "eth_sendTransaction", "eth_sendRawTransactionConditional"]);

/** True when the request's answer may be cached forever. */
export function cacheable(req: RpcRequest): boolean {
  if (IMMUTABLE.has(req.method)) return true;
  const at = PINNED_BLOCK_ARG[req.method];
  if (at === undefined) return false;
  const block = req.params?.[at];
  if (typeof block === "string") return /^0x[0-9a-fA-F]+$/.test(block); // a number or a hash, never latest/pending/safe
  if (block && typeof block === "object" && !Array.isArray(block)) return "blockHash" in block || "blockNumber" in block;
  return false;
}

export const cacheKey = (req: RpcRequest): string => JSON.stringify([req.method, req.params ?? []]);

export class RpcCache {
  readonly map = new Map<string, Json>();
  hits = 0;
  misses = 0;
  /** Pinned reads answered from latest state because the node had pruned the pinned block. */
  fallbacks = 0;
  constructor(private readonly file?: string) {
    if (file && existsSync(file)) {
      for (const line of readFileSync(file, "utf8").split("\n")) {
        if (!line) continue;
        try {
          const [key, value] = JSON.parse(line) as [string, Json];
          this.map.set(key, value);
        } catch { /* a torn last line after a crash: skip it */ }
      }
    }
  }
  get(key: string): Json | undefined { return this.map.get(key); }
  set(key: string, value: Json): void {
    if (this.map.has(key)) return;
    this.map.set(key, value);
    if (this.file) appendFileSync(this.file, `${JSON.stringify([key, value])}\n`);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Posts one request upstream with backoff on 429 / 5xx / network errors (the public RPC rate-limits bursts). */
async function upstreamCall(upstream: string, req: RpcRequest, attempts = 8): Promise<RpcResponse> {
  let delay = 400;
  for (let i = 0; ; i++) {
    try {
      const res = await fetch(upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: req.method, params: req.params ?? [] }) });
      if (res.status === 429 || res.status >= 500) throw new Error(`upstream HTTP ${res.status}`);
      const body = (await res.json()) as RpcResponse;
      if (body.error && /rate|limit|too many/i.test(body.error.message) && i < attempts) throw new Error(body.error.message);
      return { jsonrpc: "2.0", id: req.id ?? null, ...(body.error ? { error: body.error } : { result: body.result ?? null }) };
    } catch (error) {
      if (i >= attempts) return { jsonrpc: "2.0", id: req.id ?? null, error: { code: -32603, message: `rpc-cache upstream: ${(error as Error).message}` } };
      await sleep(delay);
      delay = Math.min(delay * 2, 8000);
    }
  }
}

/** The public node prunes state older than ~15 minutes. A read of a slot the fork never touched before then fails with
 * one of these; see {@link createHandler} for the fallback. */
export const PRUNED_STATE = /historical state|missing trie node|state .*not available|header not found|state is not available/i;

/** The same read at `latest`, for a pinned-block read the pruned node can no longer serve. */
export function atLatest(req: RpcRequest): RpcRequest | undefined {
  const at = PINNED_BLOCK_ARG[req.method];
  if (at === undefined || req.method === "eth_getBlockByNumber" || !req.params) return undefined;
  const params = [...req.params];
  params[at] = "latest";
  return { ...req, params };
}

/** Fork relaxation (written in the fork report): when the pinned block's state is pruned upstream, a slot the fork never
 * read is answered from the LATEST state instead. For storage nobody wrote since the fork block (every fresh address's
 * balance, allowance or nonce slot, which is what a test run mostly touches) the answer is identical; the up.sh warm-up
 * reads the hot mutable state (pools, feeds, tokens) inside the window so it stays pinned. Every fallback is counted. */
export function createHandler(upstream: string, cache: RpcCache, concurrency = 6) {
  let active = 0;
  const waiters: (() => void)[] = [];
  const slot = async () => {
    if (active >= concurrency) await new Promise<void>((r) => waiters.push(r));
    active++;
  };
  const release = () => { active--; waiters.shift()?.(); };

  const one = async (req: RpcRequest): Promise<RpcResponse> => {
    const id = req.id ?? null;
    if (REFUSED.has(req.method)) return { jsonrpc: "2.0", id, error: { code: -32601, message: "rpc-cache: transactions are never forwarded to a real network" } };
    const key = cacheable(req) ? cacheKey(req) : undefined;
    if (key) {
      const hit = cache.get(key);
      if (hit !== undefined) { cache.hits++; return { jsonrpc: "2.0", id, result: hit }; }
    }
    cache.misses++;
    await slot();
    try {
      let res = await upstreamCall(upstream, req);
      const latest = res.error && PRUNED_STATE.test(res.error.message) ? atLatest(req) : undefined;
      if (latest) {
        res = await upstreamCall(upstream, latest);
        if (res.error === undefined) { cache.fallbacks++; res = { ...res, id }; }
      }
      if (key && res.error === undefined && res.result !== null && res.result !== undefined) cache.set(key, res.result);
      return res;
    } finally {
      release();
    }
  };

  return async (body: unknown): Promise<RpcResponse | RpcResponse[]> => {
    if (Array.isArray(body)) return Promise.all((body as RpcRequest[]).map(one));
    return one(body as RpcRequest);
  };
}

if (import.meta.main) {
  const arg = (name: string, fallback?: string) => {
    const i = process.argv.indexOf(`--${name}`);
    const v = i >= 0 ? process.argv[i + 1] : undefined;
    if (v === undefined && fallback === undefined) throw new Error(`--${name} is required`);
    return v ?? fallback!;
  };
  const port = Number(arg("port"));
  const upstream = arg("upstream", "https://rpc.mainnet.chain.robinhood.com");
  const cache = new RpcCache(arg("cache"));
  const handle = createHandler(upstream, cache);
  Bun.serve({
    hostname: "127.0.0.1",
    port,
    async fetch(request) {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/health") return Response.json({ ok: true, cached: cache.map.size, hits: cache.hits, misses: cache.misses, fallbacks: cache.fallbacks });
      if (request.method !== "POST") return new Response("POST JSON-RPC", { status: 405 });
      return Response.json(await handle(await request.json()));
    },
  });
  console.log(`rpc-cache: 127.0.0.1:${port} -> ${new URL(upstream).host}, ${cache.map.size} cached answers`);
}
