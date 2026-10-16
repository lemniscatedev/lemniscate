// Pulls historical Chainlink rounds for the launch names (read only, chunked, backoff) into a local cache that is
// gitignored (scripts/replay/.cache). Feed addresses are NOT in code: pass them as
//   REPLAY_FEEDS="NVDA=0x...,TSLA=0x..."   or   --feeds-file path.json  ({"NVDA":"0x..."})
// The RPC is REPLAY_RPC_URL (default: the public mainnet endpoint from chain/chain.ts config via env RPC_URL).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decodeFunctionResult, encodeFunctionData, parseAbi } from "viem";
import { CACHE_DIR, type CachedRounds } from "../../src/sim/cache";

const abi = parseAbi([
  "function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)",
  "function getRoundData(uint80) view returns (uint80,int256,uint256,uint256,uint80)",
  "function phaseId() view returns (uint16)",
  "function decimals() view returns (uint8)",
]);

const RPC = process.env.REPLAY_RPC_URL ?? process.env.RPC_URL ?? "";
const BATCH = 20;
const MAX_RPS_GAP_MS = 1300; // ~15 calls/s with batches of 20

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rpcBatch(calls: { to: string; data: string }[]): Promise<(string | null)[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      const body = calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: "eth_call", params: [c, "latest"] }));
      const res = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      if (res.status === 429 || res.status >= 500) throw new Error(`http ${res.status}`);
      const json = (await res.json()) as { id: number; result?: string; error?: unknown }[] | { error?: unknown };
      if (!Array.isArray(json)) throw new Error(`batch error ${JSON.stringify(json).slice(0, 120)}`);
      if (json.some((r) => (r.error as { code?: number } | undefined)?.code === 429)) throw new Error("rate limited");
      const out: (string | null)[] = new Array(calls.length).fill(null);
      for (const r of json) out[r.id] = typeof r.result === "string" && r.result !== "0x" ? r.result : null;
      await sleep(MAX_RPS_GAP_MS);
      return out;
    } catch (error) {
      if (attempt >= 8) throw error;
      await sleep(Math.min(30_000, 1000 * 2 ** attempt));
    }
  }
}

function parseFeeds(): Record<string, string> {
  const fileIdx = process.argv.indexOf("--feeds-file");
  if (fileIdx >= 0) return JSON.parse(require("node:fs").readFileSync(process.argv[fileIdx + 1]!, "utf8")) as Record<string, string>;
  const env = process.env.REPLAY_FEEDS ?? "";
  const out: Record<string, string> = {};
  for (const part of env.split(",").map((s) => s.trim()).filter(Boolean)) {
    const [name, addr] = part.split("=");
    if (name && addr && /^0x[0-9a-fA-F]{40}$/.test(addr)) out[name.toUpperCase()] = addr;
  }
  return out;
}

async function main(): Promise<void> {
  if (!RPC) throw new Error("set REPLAY_RPC_URL (read-only RPC)");
  const feeds = parseFeeds();
  if (Object.keys(feeds).length === 0) throw new Error("no feeds: set REPLAY_FEEDS or --feeds-file");
  await mkdir(CACHE_DIR, { recursive: true });
  for (const [name, feed] of Object.entries(feeds)) {
    const file = join(CACHE_DIR, `${name}.json`);
    let cached: CachedRounds | undefined;
    try { cached = JSON.parse(await readFile(file, "utf8")) as CachedRounds; } catch { /* first run */ }
    const [latestRaw, decRaw] = await rpcBatch([
      { to: feed, data: encodeFunctionData({ abi, functionName: "latestRoundData" }) },
      { to: feed, data: encodeFunctionData({ abi, functionName: "decimals" }) },
    ]);
    if (!latestRaw || !decRaw) throw new Error(`${name}: feed read failed`);
    const latest = decodeFunctionResult({ abi, functionName: "latestRoundData", data: latestRaw as `0x${string}` });
    const decimals = Number(decodeFunctionResult({ abi, functionName: "decimals", data: decRaw as `0x${string}` }));
    const phase = latest[0] >> 64n;
    const lastRound = latest[0] & ((1n << 64n) - 1n);
    const rounds = cached?.rounds ?? [];
    const have = new Set(rounds.map((r) => r[0]));
    const todo: bigint[] = [];
    for (let n = 1n; n <= lastRound; n++) if (!have.has(Number(n))) todo.push(n);
    console.log(`${name}: phase ${phase}, ${lastRound} rounds, ${todo.length} to fetch`);
    for (let i = 0; i < todo.length; i += BATCH) {
      const chunk = todo.slice(i, i + BATCH);
      const res = await rpcBatch(chunk.map((n) => ({ to: feed, data: encodeFunctionData({ abi, functionName: "getRoundData", args: [(phase << 64n) | n] }) })));
      res.forEach((raw, k) => {
        if (!raw) return;
        const d = decodeFunctionResult({ abi, functionName: "getRoundData", data: raw as `0x${string}` });
        rounds.push([Number(chunk[k]!), Number(d[3]), d[1].toString()]);
      });
      if ((i / BATCH) % 10 === 0) await writeFile(file, JSON.stringify({ name, decimals, rounds } satisfies CachedRounds));
    }
    rounds.sort((a, b) => a[0] - b[0]);
    await writeFile(file, JSON.stringify({ name, decimals, rounds } satisfies CachedRounds));
    console.log(`${name}: cached ${rounds.length} rounds`);
  }
}

await main();
