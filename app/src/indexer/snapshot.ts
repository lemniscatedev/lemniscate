import type { Logger } from "pino";
import type { Sql, TransactionSql } from "postgres";
import type { Address } from "viem";
import { OptionEngineAbi, PoolAbi, PriceGuardAbi, SeriesRegistryAbi, VolOracleAbi, Erc20Abi } from "../abi";
import type { ServiceClients } from "../chain/clients";
import type { OptionDeployment } from "../chain/deployment";
import { stressLossBps } from "./stress";
import { asAddress, asBigInt, asNumber, sessionName, signedWad, usdg, wad } from "./units";

/** State read from the contracts at one block. */
export interface PoolReading {
  /** USDG held by the pool, 6 dp. */
  readonly usdgBalance: bigint;
  /** Hedge equity as last posted, USDG 6 dp. */
  readonly hedgeEquity: bigint;
  /** engine.totalLiability(), WAD USDG. */
  readonly liabilityWad: bigint;
  /** pool.nav(), WAD USDG (can be negative). */
  readonly navWad: bigint;
  /** pool.navPerShare(), WAD. */
  readonly navPerShareWad: bigint;
  /** USDG held by the reserve, 6 dp (0 when no reserve is configured). */
  readonly reserveUsdg: bigint;
}

export interface VolSnapshot {
  readonly sigmaBps: number;
  readonly stale: boolean;
}

export interface StockReading {
  readonly stock: string;
  readonly spotWad: bigint;
  readonly session: number;
  readonly fresh: boolean;
  readonly buysPaused: boolean;
  readonly updatedAt: bigint;
  readonly volDaily: VolSnapshot | undefined;
  readonly volWeekly: VolSnapshot | undefined;
  /** engine.netGreeks: the OUTSTANDING OPTIONS' Greeks, the holders' long side (decision 21). The pool is short these. */
  readonly deltaWad: bigint;
  readonly gammaWad: bigint;
  readonly vegaWad: bigint;
}

export interface SeriesReading {
  readonly id: string;
  readonly norm: bigint;
  readonly lastAccrual: bigint;
  readonly buyable: boolean;
  readonly archived: boolean;
}

export interface SnapshotReader {
  readPool(block: bigint): Promise<PoolReading>;
  readStocks(stocks: readonly string[], block: bigint): Promise<StockReading[]>;
  readSeries(ids: readonly string[], block: bigint): Promise<SeriesReading[]>;
}

const MULTICALL_CHUNK = 150;

interface Settled<T> {
  readonly status: "success" | "failure";
  readonly result?: T;
}

function must<T>(entry: Settled<T> | undefined, label: string): T {
  if (!entry || entry.status !== "success" || entry.result === undefined) throw new Error(`Snapshot read failed: ${label}`);
  return entry.result;
}

/** Reads through viem multicall at an explicit block, in chunks, so one snapshot is a handful of RPC calls. */
export function createRpcSnapshotReader(clients: ServiceClients, deployment: OptionDeployment): SnapshotReader {
  const { contracts } = deployment;
  const client = clients.stateClient;
  const multicall = async (calls: readonly unknown[], block: bigint): Promise<Settled<unknown>[]> => {
    const results: Settled<unknown>[] = [];
    for (let offset = 0; offset < calls.length; offset += MULTICALL_CHUNK) {
      const chunk = calls.slice(offset, offset + MULTICALL_CHUNK);
      const part = await client.multicall({ contracts: chunk as never, allowFailure: true, blockNumber: block });
      results.push(...(part as unknown as Settled<unknown>[]));
    }
    return results;
  };
  const engine = contracts.engine as Address;
  const pool = contracts.pool as Address;
  const usdgToken = contracts.usdg as Address;

  return {
    async readPool(block) {
      const calls: unknown[] = [
        { address: usdgToken, abi: Erc20Abi, functionName: "balanceOf", args: [pool] },
        { address: pool, abi: PoolAbi, functionName: "hedgeEquity" },
        { address: engine, abi: OptionEngineAbi, functionName: "totalLiability" },
        { address: pool, abi: PoolAbi, functionName: "nav" },
        { address: pool, abi: PoolAbi, functionName: "navPerShare" },
      ];
      if (contracts.reserve) calls.push({ address: usdgToken, abi: Erc20Abi, functionName: "balanceOf", args: [contracts.reserve as Address] });
      const r = await multicall(calls, block);
      const hedge = must(r[1], "pool.hedgeEquity") as readonly [bigint, bigint] | { equityUsdg: bigint };
      return {
        usdgBalance: asBigInt(must(r[0], "usdg.balanceOf(pool)")),
        hedgeEquity: Array.isArray(hedge) ? asBigInt(hedge[0]) : asBigInt((hedge as { equityUsdg: bigint }).equityUsdg),
        liabilityWad: asBigInt(must(r[2], "engine.totalLiability")),
        navWad: BigInt(must(r[3], "pool.nav") as bigint),
        navPerShareWad: asBigInt(must(r[4], "pool.navPerShare")),
        reserveUsdg: contracts.reserve ? asBigInt(must(r[5], "usdg.balanceOf(reserve)")) : 0n,
      };
    },

    async readStocks(stocks, block) {
      const calls: unknown[] = [];
      for (const stock of stocks) {
        calls.push(
          { address: contracts.priceGuard as Address, abi: PriceGuardAbi, functionName: "read", args: [stock as Address] },
          { address: contracts.volOracle as Address, abi: VolOracleAbi, functionName: "read", args: [stock as Address, 0] },
          { address: contracts.volOracle as Address, abi: VolOracleAbi, functionName: "read", args: [stock as Address, 1] },
          { address: engine, abi: OptionEngineAbi, functionName: "netGreeks", args: [stock as Address] },
        );
      }
      const r = await multicall(calls, block);
      const readings: StockReading[] = [];
      stocks.forEach((stock, index) => {
        const base = index * 4;
        const price = must(r[base], `priceGuard.read(${stock})`) as {
          s: bigint; session: number; fresh: boolean; buysPaused: boolean; updatedAt: bigint;
        };
        const vol = (entry: Settled<unknown> | undefined): VolSnapshot | undefined => {
          if (!entry || entry.status !== "success" || !entry.result) return undefined;
          const value = entry.result as { sigmaBps: bigint; stale: boolean };
          return { sigmaBps: Number(value.sigmaBps), stale: Boolean(value.stale) };
        };
        const greeks = must(r[base + 3], `engine.netGreeks(${stock})`) as readonly [bigint, bigint, bigint];
        readings.push({
          stock,
          spotWad: asBigInt(price.s),
          session: asNumber(price.session),
          fresh: Boolean(price.fresh),
          buysPaused: Boolean(price.buysPaused),
          updatedAt: asBigInt(price.updatedAt),
          volDaily: vol(r[base + 1]),
          volWeekly: vol(r[base + 2]),
          deltaWad: BigInt(greeks[0]),
          gammaWad: BigInt(greeks[1]),
          vegaWad: BigInt(greeks[2]),
        });
      });
      return readings;
    },

    async readSeries(ids, block) {
      const calls = ids.map((id) => ({
        address: contracts.registry as Address,
        abi: SeriesRegistryAbi,
        functionName: "seriesOf",
        args: [id as `0x${string}`],
      }));
      const r = await multicall(calls, block);
      return ids.map((id, index) => {
        const value = must(r[index], `registry.seriesOf(${id})`) as {
          norm: bigint; lastAccrual: bigint; buyable: boolean; archived: boolean;
        };
        return {
          id,
          norm: asBigInt(value.norm),
          lastAccrual: asBigInt(value.lastAccrual),
          buyable: Boolean(value.buyable),
          archived: Boolean(value.archived),
        };
      });
    },
  };
}

export interface SnapshotInput {
  readonly block: bigint;
  /** Timestamp of `block`. */
  readonly ts: Date;
  readonly pool: PoolReading;
  readonly stocks: readonly StockReading[];
  readonly series: readonly SeriesReading[];
}

/** Writes one snapshot: pool_nav, ticks and limits_state rows keyed by the block time, and brings the cached series
 * state (norm, buyable, archived) in line with the chain. Re-running it for the same block rewrites the same rows. */
export async function writeSnapshot(
  tx: TransactionSql,
  deployment: OptionDeployment,
  input: SnapshotInput,
): Promise<void> {
  const names = new Map<string, string>(deployment.stocks.map((entry) => [entry.stock, entry.name]));
  const ts = input.ts.toISOString();
  const block = input.block.toString();
  const { pool } = input;
  await tx`
    INSERT INTO pool_nav (ts, block, usdg, hedge_equity, option_liability, reserve, nav, nav_per_share)
    VALUES (
      ${ts}, ${block}, ${usdg(pool.usdgBalance)}, ${usdg(pool.hedgeEquity)}, ${wad(pool.liabilityWad)},
      ${usdg(pool.reserveUsdg)}, ${signedWad(pool.navWad)}, ${wad(pool.navPerShareWad)}
    )
    ON CONFLICT (ts) DO UPDATE SET
      block = EXCLUDED.block, usdg = EXCLUDED.usdg, hedge_equity = EXCLUDED.hedge_equity,
      option_liability = EXCLUDED.option_liability, reserve = EXCLUDED.reserve, nav = EXCLUDED.nav,
      nav_per_share = EXCLUDED.nav_per_share
  `;

  for (const reading of input.stocks) {
    const name = names.get(reading.stock) ?? null;
    await tx`
      INSERT INTO ticks (stock_token, name, ts, block, spot, session, fresh, buys_paused, price_updated_at,
                         sigma_daily_bps, sigma_weekly_bps, vol_stale)
      VALUES (
        ${reading.stock}, ${name}, ${ts}, ${block}, ${wad(reading.spotWad)}, ${sessionName(reading.session)},
        ${reading.fresh}, ${reading.buysPaused},
        ${reading.updatedAt > 0n ? new Date(Number(reading.updatedAt) * 1_000).toISOString() : null},
        ${reading.volDaily?.sigmaBps ?? null}, ${reading.volWeekly?.sigmaBps ?? null},
        ${reading.volDaily || reading.volWeekly ? Boolean(reading.volDaily?.stale || reading.volWeekly?.stale) : null}
      )
      ON CONFLICT (stock_token, ts) DO UPDATE SET
        name = EXCLUDED.name, block = EXCLUDED.block, spot = EXCLUDED.spot, session = EXCLUDED.session, fresh = EXCLUDED.fresh,
        buys_paused = EXCLUDED.buys_paused, price_updated_at = EXCLUDED.price_updated_at,
        sigma_daily_bps = EXCLUDED.sigma_daily_bps, sigma_weekly_bps = EXCLUDED.sigma_weekly_bps, vol_stale = EXCLUDED.vol_stale
    `;
    if (name) {
      // engine.netGreeks is the holders' long side (decision 21); the pool is short exactly that.
      const stress = stressLossBps({
        deltaWad: -reading.deltaWad,
        gammaWad: -reading.gammaWad,
        spotWad: reading.spotWad,
        navWad: pool.navWad,
      });
      await tx`
        INSERT INTO limits_state (name, ts, block, stock_token, net_delta, net_gamma, net_vega, stress_loss_bps)
        VALUES (
          ${name}, ${ts}, ${block}, ${reading.stock}, ${signedWad(reading.deltaWad)}, ${signedWad(reading.gammaWad)},
          ${signedWad(reading.vegaWad)}, ${stress}
        )
        ON CONFLICT (name, ts) DO UPDATE SET
          block = EXCLUDED.block, stock_token = EXCLUDED.stock_token, net_delta = EXCLUDED.net_delta,
          net_gamma = EXCLUDED.net_gamma, net_vega = EXCLUDED.net_vega, stress_loss_bps = EXCLUDED.stress_loss_bps
      `;
    }
  }

  for (const reading of input.series) {
    await tx`
      UPDATE series SET
        norm = ${wad(reading.norm)},
        last_accrual = ${new Date(Number(reading.lastAccrual) * 1_000).toISOString()},
        buyable = ${reading.buyable},
        archived = ${reading.archived}
      WHERE id = ${reading.id}
    `;
  }
}

export interface SnapshotRuntime {
  readonly sql: Sql;
  readonly deployment: OptionDeployment;
  readonly reader: SnapshotReader;
  readonly logger: Logger;
}

/** Reads the chain at `block` and stores the snapshot. Reads happen before the transaction opens, so a slow RPC never
 * holds a database transaction. */
export async function takeSnapshot(runtime: SnapshotRuntime, block: bigint, blockTime: Date): Promise<SnapshotInput> {
  const stocks = runtime.deployment.stocks.map((entry) => asAddress(entry.stock));
  const activeSeries = (await runtime.sql`SELECT id FROM series WHERE archived = false AND listed_block <= ${block.toString()} ORDER BY id`) as unknown as { id: string }[];
  const [pool, stockReadings, seriesReadings] = await Promise.all([
    runtime.reader.readPool(block),
    runtime.reader.readStocks(stocks, block),
    runtime.reader.readSeries(activeSeries.map((row) => row.id), block),
  ]);
  const input: SnapshotInput = { block, ts: blockTime, pool, stocks: stockReadings, series: seriesReadings };
  await runtime.sql.begin(async (tx) => {
    await writeSnapshot(tx, runtime.deployment, input);
  });
  return input;
}
