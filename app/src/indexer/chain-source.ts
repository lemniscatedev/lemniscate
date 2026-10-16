import type { Address, Hex } from "viem";
import type { ServiceClients } from "../chain/clients";
import type { BlockHeader, RpcLog } from "./types";
import { asBigInt, blockHex, parseChainTimestamp } from "./units";

export interface LogRange {
  readonly fromBlock: bigint;
  readonly toBlock: bigint;
  readonly lemniscateAddresses: readonly Address[];
  readonly stockAddresses: readonly Address[];
  readonly stockTopics: readonly Hex[];
}

/** Everything the ingest loop needs from the chain. Production reads it over the RPC pool; tests substitute a fake
 * chain, which is how reorgs are simulated. */
export interface ChainSource {
  getHead(): Promise<bigint>;
  getLogs(range: LogRange): Promise<{ readonly lemniscateLogs: readonly RpcLog[]; readonly stockLogs: readonly RpcLog[] }>;
  /** Headers by number. A block the node does not have comes back as undefined (that is how a shrunk chain looks). */
  getHeaders(numbers: readonly bigint[]): Promise<ReadonlyMap<bigint, BlockHeader | undefined>>;
  /** Calldata of a transaction, if the node still serves it. */
  getTransactionInput(hash: string): Promise<Hex | undefined>;
}

function logFilter(addresses: readonly Address[], fromBlock: bigint, toBlock: bigint, topics?: readonly Hex[]): Record<string, unknown> {
  return {
    address: addresses.length > 0 ? [...addresses] : ["0x0000000000000000000000000000000000000000"],
    fromBlock: blockHex(fromBlock),
    toBlock: blockHex(toBlock),
    ...(topics ? { topics: [[...topics]] } : {}),
  };
}

function parseHeader(value: unknown): BlockHeader | undefined {
  const header = value as { number?: unknown; hash?: unknown; parentHash?: unknown; timestamp?: unknown } | null | undefined;
  if (!header || typeof header.hash !== "string" || typeof header.parentHash !== "string") return undefined;
  const timestamp = parseChainTimestamp(header.timestamp);
  if (!timestamp) return undefined;
  return {
    number: asBigInt(header.number),
    hash: header.hash.toLowerCase(),
    parentHash: header.parentHash.toLowerCase(),
    timestamp,
  };
}

/** Reads through the rotating RPC pool. Header and log calls go through `requestBatch`, which never serves cached
 * responses, so a reorg is always visible. */
export function createRpcChainSource(clients: ServiceClients): ChainSource {
  const { pool } = clients;
  return {
    getHead: () => clients.logsClient.getBlockNumber(),
    async getLogs(range) {
      const [lemniscate, stock] = await pool.requestBatch("logs", [
        { method: "eth_getLogs", params: [logFilter(range.lemniscateAddresses, range.fromBlock, range.toBlock)] },
        { method: "eth_getLogs", params: [logFilter(range.stockAddresses, range.fromBlock, range.toBlock, range.stockTopics)] },
      ]);
      if (!Array.isArray(lemniscate) || !Array.isArray(stock)) throw new Error("RPC returned an invalid eth_getLogs response");
      return { lemniscateLogs: lemniscate as RpcLog[], stockLogs: stock as RpcLog[] };
    },
    async getHeaders(numbers) {
      const result = new Map<bigint, BlockHeader | undefined>();
      if (numbers.length === 0) return result;
      const unique = [...new Set(numbers)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      const responses = await pool.requestBatch(
        "logs",
        unique.map((number) => ({ method: "eth_getBlockByNumber", params: [blockHex(number), false] })),
      );
      unique.forEach((number, index) => result.set(number, parseHeader(responses[index])));
      return result;
    },
    async getTransactionInput(hash) {
      const [tx] = await pool.requestBatch("logs", [{ method: "eth_getTransactionByHash", params: [hash] }]);
      const input = (tx as { input?: unknown } | null | undefined)?.input;
      return typeof input === "string" && input.startsWith("0x") ? (input as Hex) : undefined;
    },
  };
}
