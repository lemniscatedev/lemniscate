import type { Address, Hex } from "viem";
import { OptionEngineAbi, SeriesRegistryAbi } from "../abi";
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

/** The engine's live list (series with tokens outstanding that are not retired as dust) and each one's last-touch
 * outstanding value, plus the dust line (engine guards.minTradeUsdg as WAD): what accrueMany and retireDust judge by. */
export interface LiveRisk {
  live: { id: Hex; stock: Address; value: bigint }[];
  dustWad: bigint;
}

export async function readLiveRisk(context: Pick<KeeperContext, "clients" | "deployment">): Promise<LiveRisk> {
  const engine = context.deployment.contracts.engine as Address;
  const stocks = context.deployment.stocks.map((entry) => entry.stock.toLowerCase() as Address);
  const [guards, ...lists] = await chunkedMulticall(context, [
    { address: engine, abi: OptionEngineAbi, functionName: "guards" },
    ...stocks.map((stock) => ({ address: engine, abi: OptionEngineAbi, functionName: "liveSeries", args: [stock] })),
  ]) as [readonly [bigint, number, number], ...(readonly Hex[])[]];
  const live = stocks.flatMap((stock, index) => (lists[index] ?? []).map((id) => ({ id, stock, value: 0n })));
  if (live.length) {
    const risks = await chunkedMulticall(context, live.map(({ id }) => ({
      address: engine, abi: OptionEngineAbi, functionName: "seriesRisk", args: [id],
    }))) as (readonly bigint[])[];
    live.forEach((entry, index) => { entry.value = BigInt(risks[index]![0]!); });
  }
  return { live, dustWad: BigInt(guards[0]) * 10n ** 12n };
}
