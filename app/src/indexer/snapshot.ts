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
  /** engine.navLiability(false) and (true), WAD (decision 36); absent when the engine does not answer. */
  readonly navLiabilityLowWad?: bigint;
  readonly navLiabilityHighWad?: bigint;
  /** engine.guards(): hold and ORC-4 settle delay, seconds (0 = the engine default). */
  readonly holdSeconds?: number;
  readonly haltSettleDelaySeconds?: number;
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
  /** PriceGuard.tradeTwap, WAD (decision 30); 0 or absent when unavailable. */
  readonly tradeTwapWad?: bigint;
  /** engine.settlePrice, WAD (ORC-4, decision 31); 0 or absent when not settled. */
  readonly settlePriceWad?: bigint;
  /** PriceGuard.haltedSince, unix seconds; 0 or absent when no halt is latched. */
  readonly haltedSince?: bigint;
}

/** engine.holdOf(id, account): an open hold until `until` (unix seconds) at buy-time S `sWad` (decision 30). */
export interface HoldReading {
  readonly seriesId: string;
  readonly account: string;
  readonly until: bigint;
  readonly sWad: bigint;
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
  /** engine.holdOf for each pair; a failed read is left out. Optional: a reader without it stores no holds. */
  readHolds?(pairs: readonly { seriesId: string; account: string }[], block: bigint): Promise<HoldReading[]>;
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
      const extra = calls.length;
      // Decisions 30, 31, 36: optional reads (an older engine without them leaves the fields out).
      calls.push(
        { address: engine, abi: OptionEngineAbi, functionName: "navLiability", args: [false] },
        { address: engine, abi: OptionEngineAbi, functionName: "navLiability", args: [true] },
        { address: engine, abi: OptionEngineAbi, functionName: "guards" },
      );
      const r = await multicall(calls, block);
      const ok = (entry: Settled<unknown> | undefined) => entry && entry.status === "success" && entry.result !== undefined;
      const guards = ok(r[extra + 2]) ? r[extra + 2]!.result as readonly [bigint, number | bigint, number | bigint] : undefined;
      const optionalPool = {
        ...(ok(r[extra]) ? { navLiabilityLowWad: asBigInt(r[extra]!.result) } : {}),
        ...(ok(r[extra + 1]) ? { navLiabilityHighWad: asBigInt(r[extra + 1]!.result) } : {}),
        ...(guards ? { holdSeconds: Number(guards[1]), haltSettleDelaySeconds: Number(guards[2]) } : {}),
      };
      const hedge = must(r[1], "pool.hedgeEquity") as readonly [bigint, bigint] | { equityUsdg: bigint };
      return {
        usdgBalance: asBigInt(must(r[0], "usdg.balanceOf(pool)")),
        hedgeEquity: Array.isArray(hedge) ? asBigInt(hedge[0]) : asBigInt((hedge as { equityUsdg: bigint }).equityUsdg),
        liabilityWad: asBigInt(must(r[2], "engine.totalLiability")),
        navWad: BigInt(must(r[3], "pool.nav") as bigint),
        navPerShareWad: asBigInt(must(r[4], "pool.navPerShare")),
        reserveUsdg: contracts.reserve ? asBigInt(must(r[5], "usdg.balanceOf(reserve)")) : 0n,
        ...optionalPool,
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
          // Decision 30/31: the trade TWAP, the ORC-4 settlement price and the halt latch. Optional: a failure reads 0.
          { address: contracts.priceGuard as Address, abi: PriceGuardAbi, functionName: "tradeTwap", args: [stock as Address] },
          { address: engine, abi: OptionEngineAbi, functionName: "settlePrice", args: [stock as Address] },
          { address: contracts.priceGuard as Address, abi: PriceGuardAbi, functionName: "haltedSince", args: [stock as Address] },
        );
      }
      const r = await multicall(calls, block);
      const optional = (entry: Settled<unknown> | undefined): bigint =>
        (entry && entry.status === "success" && entry.result !== undefined ? asBigInt(entry.result) : 0n);
      const readings: StockReading[] = [];
      stocks.forEach((stock, index) => {
        const base = index * 7;
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
          tradeTwapWad: optional(r[base + 4]),
          settlePriceWad: optional(r[base + 5]),
          haltedSince: optional(r[base + 6]),
        });
      });
      return readings;
    },

    async readHolds(pairs, block) {
      const r = await multicall(pairs.map(({ seriesId, account }) => ({
        address: engine, abi: OptionEngineAbi, functionName: "holdOf", args: [seriesId as `0x${string}`, account as Address],
      })), block);
      const found: HoldReading[] = [];
      pairs.forEach((pair, index) => {
        const entry = r[index];
        if (!entry || entry.status !== "success" || !entry.result) return;
        const value = entry.result as { until: bigint; s: bigint };
        found.push({ ...pair, until: asBigInt(value.until), sWad: asBigInt(value.s) });
      });
      return found;
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
  /** Holds read for this snapshot (open or expired: an expired one clears the stored row). */
  readonly holds?: readonly HoldReading[];
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
    INSERT INTO pool_nav (ts, block, usdg, hedge_equity, option_liability, reserve, nav, nav_per_share,
                          nav_liability_low, nav_liability_high, hold_seconds, halt_settle_delay_seconds)
    VALUES (
      ${ts}, ${block}, ${usdg(pool.usdgBalance)}, ${usdg(pool.hedgeEquity)}, ${wad(pool.liabilityWad)},
      ${usdg(pool.reserveUsdg)}, ${signedWad(pool.navWad)}, ${wad(pool.navPerShareWad)},
      ${pool.navLiabilityLowWad === undefined ? null : wad(pool.navLiabilityLowWad)},
      ${pool.navLiabilityHighWad === undefined ? null : wad(pool.navLiabilityHighWad)},
      ${pool.holdSeconds === undefined ? null : pool.holdSeconds}, ${pool.haltSettleDelaySeconds === undefined ? null : pool.haltSettleDelaySeconds}
    )
    ON CONFLICT (ts) DO UPDATE SET
      block = EXCLUDED.block, usdg = EXCLUDED.usdg, hedge_equity = EXCLUDED.hedge_equity,
      option_liability = EXCLUDED.option_liability, reserve = EXCLUDED.reserve, nav = EXCLUDED.nav,
      nav_per_share = EXCLUDED.nav_per_share, nav_liability_low = EXCLUDED.nav_liability_low,
      nav_liability_high = EXCLUDED.nav_liability_high, hold_seconds = EXCLUDED.hold_seconds,
      halt_settle_delay_seconds = EXCLUDED.halt_settle_delay_seconds
  `;

  for (const reading of input.stocks) {
    const name = names.get(reading.stock) ?? null;
    await tx`
      INSERT INTO ticks (stock_token, name, ts, block, spot, session, fresh, buys_paused, price_updated_at,
                         sigma_daily_bps, sigma_weekly_bps, vol_stale, trade_twap, settle_price, halted_since)
      VALUES (
        ${reading.stock}, ${name}, ${ts}, ${block}, ${wad(reading.spotWad)}, ${sessionName(reading.session)},
        ${reading.fresh}, ${reading.buysPaused},
        ${reading.updatedAt > 0n ? new Date(Number(reading.updatedAt) * 1_000).toISOString() : null},
        ${reading.volDaily?.sigmaBps ?? null}, ${reading.volWeekly?.sigmaBps ?? null},
        ${reading.volDaily || reading.volWeekly ? Boolean(reading.volDaily?.stale || reading.volWeekly?.stale) : null},
        ${reading.tradeTwapWad ? wad(reading.tradeTwapWad) : null}, ${reading.settlePriceWad ? wad(reading.settlePriceWad) : null},
        ${reading.haltedSince ? new Date(Number(reading.haltedSince) * 1_000).toISOString() : null}
      )
      ON CONFLICT (stock_token, ts) DO UPDATE SET
        name = EXCLUDED.name, block = EXCLUDED.block, spot = EXCLUDED.spot, session = EXCLUDED.session, fresh = EXCLUDED.fresh,
        buys_paused = EXCLUDED.buys_paused, price_updated_at = EXCLUDED.price_updated_at,
        sigma_daily_bps = EXCLUDED.sigma_daily_bps, sigma_weekly_bps = EXCLUDED.sigma_weekly_bps, vol_stale = EXCLUDED.vol_stale,
        trade_twap = EXCLUDED.trade_twap, settle_price = EXCLUDED.settle_price, halted_since = EXCLUDED.halted_since
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

  for (const hold of input.holds ?? []) {
    if (hold.until * 1_000n <= BigInt(input.ts.getTime()) || hold.sWad === 0n) {
      await tx`DELETE FROM holds WHERE series_id = ${hold.seriesId} AND account = ${hold.account}`;
      continue;
    }
    await tx`
      INSERT INTO holds (series_id, account, until, s, block)
      VALUES (${hold.seriesId}, ${hold.account}, ${new Date(Number(hold.until) * 1_000).toISOString()}, ${wad(hold.sWad)}, ${block})
      ON CONFLICT (series_id, account) DO UPDATE SET until = EXCLUDED.until, s = EXCLUDED.s, block = EXCLUDED.block
    `;
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

/** Longest hold the engine allows (LemniscateEngine.MAX_HOLD_SECONDS, one day): only pairs touched this recently can
 * carry one. */
const HOLD_LOOKBACK_MS = 86_400_000;
/** Most (series, account) pairs re-read per snapshot, newest first. */
export const HOLD_PAIRS_PER_SNAPSHOT = 600;

/** (series, account) pairs that may hold: buy recipients and option-token receivers of the last day, and every stored
 * hold (so an expired or extended one is corrected). */
export async function holdCandidates(sql: Sql, at: Date): Promise<{ seriesId: string; account: string }[]> {
  const cut = new Date(at.getTime() - HOLD_LOOKBACK_MS).toISOString();
  const rows = (await sql`
    SELECT series_id, account FROM (
      SELECT series_id, account, max(ts) AS ts FROM (
        SELECT series_id, recipient AS account, ts FROM trades WHERE side = 'buy' AND ts > ${cut}
        UNION ALL
        SELECT series_id, to_addr, ts FROM transfers
        WHERE series_id IS NOT NULL AND ts > ${cut} AND to_addr <> '0x0000000000000000000000000000000000000000'
        UNION ALL
        SELECT series_id, account, until FROM holds
      ) touched GROUP BY series_id, account
    ) recent ORDER BY ts DESC LIMIT ${HOLD_PAIRS_PER_SNAPSHOT}
  `) as unknown as { series_id: string; account: string }[];
  return rows.map((row) => ({ seriesId: row.series_id, account: row.account }));
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
  const pairs = runtime.reader.readHolds ? await holdCandidates(runtime.sql, blockTime) : [];
  const [pool, stockReadings, seriesReadings, holdReadings] = await Promise.all([
    runtime.reader.readPool(block),
    runtime.reader.readStocks(stocks, block),
    runtime.reader.readSeries(activeSeries.map((row) => row.id), block),
    pairs.length && runtime.reader.readHolds ? runtime.reader.readHolds(pairs, block) : Promise.resolve([] as HoldReading[]),
  ]);
  const input: SnapshotInput = { block, ts: blockTime, pool, stocks: stockReadings, series: seriesReadings, holds: holdReadings };
  await runtime.sql.begin(async (tx) => {
    await writeSnapshot(tx, runtime.deployment, input);
  });
  return input;
}
