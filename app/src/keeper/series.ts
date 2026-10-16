import type { Address, Hex } from "viem";
import { SeriesRegistryAbi } from "../abi";
import type { KeeperContext } from "./context";

/** One registry entry as the chain reports it (ISeriesRegistry.seriesOf), with the id attached. */
export interface ChainSeries {
  id: Hex;
  stock: Address;
  isCall: boolean;
  /** 0 DAILY, 1 WEEKLY */
  speed: number;
  tauSeconds: number;
  strike: bigint;
  token: Address;
  norm: bigint;
  lastAccrual: bigint;
  listedAt: bigint;
  buyable: boolean;
  archived: boolean;
}

export const MULTICALL_CHUNK = 200;

/** Runs `calls` through multicall in chunks and returns the results in order. A failing call fails the whole read:
 * a keeper must not act on half a picture. */
export async function chunkedMulticall(context: Pick<KeeperContext, "clients">, calls: readonly unknown[]): Promise<unknown[]> {
  const results: unknown[] = [];
  for (let offset = 0; offset < calls.length; offset += MULTICALL_CHUNK) {
    const part = await context.clients.stateClient.multicall({
      contracts: calls.slice(offset, offset + MULTICALL_CHUNK) as never,
      allowFailure: false,
    });
    results.push(...(part as unknown[]));
  }
  return results;
}

/** Reads every registered series straight from the registry (the chain is the truth; the indexer may lag a block or
 * two behind a listing the keeper just sent). Ids are append-only, so already known ids are never re-enumerated. */
export function createSeriesReader(context: Pick<KeeperContext, "clients" | "deployment">) {
  const registry = context.deployment.contracts.registry as Address;
  const ids: Hex[] = [];
  return {
    async readAll(): Promise<ChainSeries[]> {
      const count = Number(await context.clients.stateClient.readContract({
        address: registry, abi: SeriesRegistryAbi, functionName: "seriesCount",
      }));
      if (count > ids.length) {
        const fresh = await chunkedMulticall(context, Array.from({ length: count - ids.length }, (_, i) => ({
          address: registry, abi: SeriesRegistryAbi, functionName: "seriesIdAt", args: [BigInt(ids.length + i)],
        })));
        ids.push(...(fresh as Hex[]));
      }
      if (!ids.length) return [];
      const rows = await chunkedMulticall(context, ids.map((id) => ({
        address: registry, abi: SeriesRegistryAbi, functionName: "seriesOf", args: [id],
      }))) as {
        stock: Address; isCall: boolean; speed: number; tauSeconds: number; strike: bigint; token: Address;
        norm: bigint; lastAccrual: bigint; listedAt: bigint; buyable: boolean; archived: boolean;
      }[];
      return rows.map((row, index) => ({
        id: ids[index]!,
        stock: row.stock.toLowerCase() as Address,
        isCall: row.isCall,
        speed: Number(row.speed),
        tauSeconds: Number(row.tauSeconds),
        strike: BigInt(row.strike),
        token: row.token.toLowerCase() as Address,
        norm: BigInt(row.norm),
        lastAccrual: BigInt(row.lastAccrual),
        listedAt: BigInt(row.listedAt),
        buyable: row.buyable,
        archived: row.archived,
      }));
    },
  };
}
