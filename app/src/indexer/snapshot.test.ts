// Regression for the snapshot fan-out report: thousands of queued accounts
// (e.g. from dust transfers) used to be read in one allowFailure:false
// multicall fanned out in parallel, so a provider throttle failed the whole
// snapshot and cooled every RPC endpoint.
import { expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionResult, parseAbi, type Hex } from "viem";
import { loadConfig } from "../config";
import { createRpcPool } from "../chain/rpc-pool";
import { createClients } from "../chain/clients";
import { createLogger } from "../log";
import { ACCOUNT_CHUNK_SIZE, MAX_ACCOUNTS_PER_SNAPSHOT, takeSnapshot, type SnapshotRuntime } from "./snapshot";

const config = loadConfig({
  DATABASE_URL: "postgres://u:p@localhost/db", POSTGRES_PASSWORD: "x", ALCHEMY_API_KEYS: "k1,k2", NETWORK: "mainnet",
});
const a = (n: number) => `0x${n.toString(16).padStart(40, "0")}` as Hex;
const deployment = { chainId: 4663, network: "mainnet", deployBlock: 1, deployer: a(1), admin: a(1), keeper: a(1),
  contracts: { engine: a(2), vault: a(3), marketHours: a(4), lens: a(5), hedgeAdapter: a(6), usdg: a(7),
    engineImpl: a(8), vaultImpl: a(9), marketHoursImpl: a(10) }, markets: [] };
const aggregate3 = parseAbi(["function aggregate3((address,bool,bytes)[]) returns ((bool,bytes)[])"]);
// Sixteen zero words decode as an empty array, a zeroed struct or false/0.
const ZERO_WORD = `0x${"0".repeat(64 * 16)}` as Hex;

async function run(accounts: number, ethCallLimit: number, failing = new Set<string>()) {
  let ethCalls = 0;
  let largestBatch = 0;
  const pool = createRpcPool(config, { requestFactory: (endpoint) => async (request) => {
    if (request.method === "eth_getBlockByNumber") return { timestamp: "0x6700000" };
    if (request.method === "eth_call") {
      ethCalls++;
      if (ethCalls > ethCallLimit) {
        throw Object.assign(new Error(`HTTP request failed. Status: 429 (${endpoint.id})`), { status: 429 });
      }
      const data = (request.params as [{ data: Hex }])[0].data;
      const calls = decodeFunctionData({ abi: aggregate3, data }).args[0] as readonly (readonly [Hex, boolean, Hex])[];
      largestBatch = Math.max(largestBatch, calls.length);
      const results = calls.map(([, , callData]) => {
        const account = callData.length === 74 ? `0x${callData.slice(34)}`.toLowerCase() : undefined;
        if (account && failing.has(account)) return [false, "0x"] as const;
        return [true, ZERO_WORD] as const;
      });
      return encodeFunctionResult({ abi: aggregate3, functionName: "aggregate3", result: results as never });
    }
    if (request.method === "eth_getLogs") return [];
    throw new Error(`unexpected ${request.method}`);
  } });
  const clients = createClients(config, pool);
  const written: string[] = [];
  const tx = Object.assign(async (strings: TemplateStringsArray, ...values: unknown[]) => {
    if (strings.join("?").includes("INSERT INTO vault_account_state")) written.push(String(values[0]));
    return [];
  }, { notify: async () => undefined });
  const sql = { begin: async (fn: (transaction: typeof tx) => Promise<unknown>) => fn(tx) };
  const queued = new Set(Array.from({ length: accounts }, (_, i) => a(0x1000 + i).toLowerCase()));
  const runtime = { clients, sql, deployment, marketsById: new Map(), marketStatesById: new Map(),
    globalConfig: {}, vaultConfig: {}, marketHours: {}, logger: createLogger("silent") } as unknown as SnapshotRuntime;
  const result = await takeSnapshot(runtime, 100n, queued).then((value) => value, (error: Error) => error);
  const logs = await pool.requestBatch("logs", [{ method: "eth_getLogs", params: [{}] }])
    .then(() => "logs ok", (error: Error) => error.message);
  return { ethCalls, largestBatch, result, written, logs,
    cooling: pool.stats().endpoints.filter((endpoint) => endpoint.cooling).length };
}

test("a dust-transfer account backlog is chunked, capped and carried over instead of failing the snapshot", async () => {
  const outcome = await run(5_000, 300);
  expect(outcome.result).not.toBeInstanceOf(Error);
  expect(outcome.logs).toBe("logs ok");
  expect(outcome.cooling).toBe(0);
  // One core read plus one eth_call per chunk of accounts, capped per snapshot.
  expect(outcome.ethCalls).toBe(1 + MAX_ACCOUNTS_PER_SNAPSHOT / ACCOUNT_CHUNK_SIZE);
  expect(outcome.largestBatch).toBeLessThanOrEqual(ACCOUNT_CHUNK_SIZE * 2);
  expect(outcome.written.length).toBe(MAX_ACCOUNTS_PER_SNAPSHOT);
  const processed = (outcome.result as Awaited<ReturnType<typeof takeSnapshot>>).processedAccounts;
  expect(processed.size).toBe(MAX_ACCOUNTS_PER_SNAPSHOT);
});

test("failed account reads stay queued while the snapshot itself succeeds", async () => {
  const bad = a(0x1000 + 3).toLowerCase();
  const outcome = await run(10, 1e9, new Set([bad]));
  expect(outcome.result).not.toBeInstanceOf(Error);
  const processed = (outcome.result as Awaited<ReturnType<typeof takeSnapshot>>).processedAccounts;
  expect(processed.size).toBe(9);
  expect(processed.has(bad)).toBe(false);
  expect(outcome.written).not.toContain(bad);
});

test("a throttled account chunk leaves the remaining accounts queued without failing the snapshot", async () => {
  // The core read and two account chunks succeed, then the provider throttles.
  const outcome = await run(1_000, 3);
  expect(outcome.result).not.toBeInstanceOf(Error);
  const processed = (outcome.result as Awaited<ReturnType<typeof takeSnapshot>>).processedAccounts;
  expect(processed.size).toBe(2 * ACCOUNT_CHUNK_SIZE);
});
