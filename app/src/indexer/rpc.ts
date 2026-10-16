import type { RpcPool } from "../chain/rpc-pool";
import type { Address, Hex } from "viem";
import type { RpcLog } from "./types";
import { asBigInt, blockHex, parseChainTimestamp } from "./units";

export interface LogRange {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly lemniscateAddresses: readonly Address[];
  readonly externalAddresses: readonly Address[];
  readonly externalTopics: readonly Hex[];
}

function logFilter(
  addresses: readonly Address[],
  fromBlock: bigint,
  toBlock: bigint,
  topics?: readonly Hex[],
): Record<string, unknown> {
  return {
    address: addresses.length > 0 ? [...addresses] : ["0x0000000000000000000000000000000000000000"],
    fromBlock: blockHex(fromBlock),
    toBlock: blockHex(toBlock),
    ...(topics ? { topics: [[...topics]] } : {}),
  };
}

export async function fetchLogPair(pool: RpcPool, range: LogRange): Promise<{
  readonly lemniscateLogs: readonly RpcLog[];
  readonly externalLogs: readonly RpcLog[];
}> {
  const [lemniscateResult, externalResult] = await pool.requestBatch("logs", [
    {
      method: "eth_getLogs",
      params: [logFilter(range.lemniscateAddresses, range.fromBlock, range.toBlock)],
    },
    {
      method: "eth_getLogs",
      params: [
        logFilter(range.externalAddresses, range.fromBlock, range.toBlock, range.externalTopics),
      ],
    },
  ]);
  if (!Array.isArray(lemniscateResult) || !Array.isArray(externalResult)) {
    throw new Error("RPC returned an invalid eth_getLogs response");
  }
  return {
    lemniscateLogs: lemniscateResult as RpcLog[],
    externalLogs: externalResult as RpcLog[],
  };
}

export type BlockTimestampCache = Map<bigint, Date>;

export async function timestampsForLogs(
  pool: RpcPool,
  logs: readonly RpcLog[],
  cache: BlockTimestampCache,
): Promise<ReadonlyMap<RpcLog, Date>> {
  const timestamps = new Map<RpcLog, Date>();
  const missing = new Set<bigint>();
  for (const log of logs) {
    const logTimestamp = parseChainTimestamp(log.blockTimestamp);
    if (logTimestamp) {
      timestamps.set(log, logTimestamp);
      const blockNumber = asBigInt(log.blockNumber, -1n);
      if (blockNumber >= 0n) cache.set(blockNumber, logTimestamp);
      continue;
    }
    const blockNumber = asBigInt(log.blockNumber, -1n);
    if (blockNumber < 0n) continue;
    const cached = cache.get(blockNumber);
    if (cached && cached.getTime() > 0) timestamps.set(log, cached);
    else missing.add(blockNumber);
  }

  if (missing.size > 0) {
    const blocks = [...missing].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    const headers = await pool.requestBatch(
      "logs",
      blocks.map((blockNumber) => ({
        method: "eth_getBlockByNumber",
        params: [blockHex(blockNumber), false],
      })),
    );
    for (const [index, blockNumber] of blocks.entries()) {
      const header = headers[index] as { timestamp?: unknown } | null | undefined;
      const timestamp = parseChainTimestamp(header?.timestamp);
      if (!timestamp) throw new Error(`Block timestamp unavailable for ${blockNumber}`);
      cache.set(blockNumber, timestamp);
    }
    for (const log of logs) {
      if (timestamps.has(log)) continue;
      const blockNumber = asBigInt(log.blockNumber, -1n);
      const timestamp = cache.get(blockNumber);
      if (timestamp) timestamps.set(log, timestamp);
    }
  }

  for (const log of logs) {
    if (timestamps.has(log)) continue;
    throw new Error(`Log timestamp unavailable at block ${String(log.blockNumber)}`);
  }
  return timestamps;
}

export async function timestampAtBlock(pool: RpcPool, blockNumber: bigint): Promise<Date> {
  const [result] = await pool.requestBatch("logs", [
    {
      method: "eth_getBlockByNumber",
      params: [blockHex(blockNumber), false],
    },
  ]);
  const header = result as { timestamp?: unknown } | null | undefined;
  const timestamp = parseChainTimestamp(header?.timestamp);
  if (!timestamp) throw new Error(`Block timestamp unavailable for ${blockNumber}`);
  return timestamp;
}
