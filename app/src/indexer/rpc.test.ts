import { expect, test } from "bun:test";
import type { RpcPool } from "../chain/rpc-pool";
import type { RpcLog } from "./types";
import { timestampsForLogs, timestampAtBlock } from "./rpc";

const seconds = 1790969618;
const expected = new Date(seconds * 1000);
const log = (block: bigint, blockTimestamp?: RpcLog["blockTimestamp"]) =>
  ({ blockNumber: block, ...(blockTimestamp === undefined ? {} : { blockTimestamp }) }) as RpcLog;

test("RHC zero log timestamps resolve once per distinct block and cache the real dates", async () => {
  const calls: unknown[][] = [];
  const pool = { requestBatch: async (_kind: unknown, requests: unknown[]) => {
    calls.push(requests); return requests.map(() => ({ timestamp: `0x${seconds.toString(16)}` }));
  } } as unknown as RpcPool;
  const logs = [log(10n, "0x0"), log(10n, 0), log(11n, 0n), log(11n, null), log(11n)];
  const cache = new Map<bigint, Date>();
  const resolved = await timestampsForLogs(pool, logs, cache);
  expect(calls).toEqual([[
    { method: "eth_getBlockByNumber", params: ["0xa", false] },
    { method: "eth_getBlockByNumber", params: ["0xb", false] },
  ]]);
  for (const item of logs) expect(resolved.get(item)).toEqual(expected);
  const later = log(10n, "0x0");
  expect((await timestampsForLogs(pool, [later], cache)).get(later)).toEqual(expected);
  expect(calls).toHaveLength(1);
});

test("valid log timestamps avoid a header request", async () => {
  const pool = { requestBatch: () => { throw new Error("Unexpected RPC read"); } } as unknown as RpcPool;
  const item = log(10n, BigInt(seconds));
  const cache = new Map<bigint, Date>();
  expect((await timestampsForLogs(pool, [item], cache)).get(item)).toEqual(expected);
  expect(cache.get(10n)).toEqual(expected);
});

test("an epoch cache entry is repaired using the header", async () => {
  const pool = { requestBatch: async () => [{ timestamp: seconds }] } as unknown as RpcPool;
  const item = log(10n, "0x0");
  const cache = new Map([[10n, new Date(0)]]);
  expect((await timestampsForLogs(pool, [item], cache)).get(item)).toEqual(expected);
  expect(cache.get(10n)).toEqual(expected);
});

test("missing/zero/invalid block headers fail ingestion instead of persisting epoch dates", async () => {
  for (const header of [null, {}, { timestamp: "0x0" }, { timestamp: "bad" }]) {
    const pool = { requestBatch: async () => [header] } as unknown as RpcPool;
    await expect(timestampsForLogs(pool, [log(10n, "0x0")], new Map())).rejects.toThrow("Block timestamp unavailable");
    await expect(timestampAtBlock(pool, 10n)).rejects.toThrow("Block timestamp unavailable");
  }
});
