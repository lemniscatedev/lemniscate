import { encodeFunctionData, type Address, type Hex } from "viem";
import { PriceGuardAbi, SeriesRegistryAbi } from "../../abi";
import {
  ARCHIVE_MONEYNESS_BPS, RELIST_NORM, SPEEDS, STRIKE_STEP_USD, gridStrikes, moneynessBps, seriesId,
} from "../../config/listing";
import { safeErrorSummary } from "../../log";
import { saveJobMeta, type KeeperContext } from "../context";
import { chunkedMulticall, createSeriesReader, type ChainSeries } from "../series";

// SessionKind in OptionTypes.sol: REGULAR 0, EXTENDED 1, CLOSED 2, UNKNOWN 3, HALTED 4.
const LIVE_SESSIONS = new Set([0, 1]);
const SESSION_LABEL = ["REGULAR", "EXTENDED", "CLOSED", "UNKNOWN", "HALTED"];
/** A series listed less than this long ago that is still not buyable gets setBuyable(true) (a listing whose second step failed). */
const RECENT_LISTING_SECONDS = 86_400n;

const etDate = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });

interface PriceRead {
  s: bigint; session: number; fresh: boolean; buysPaused: boolean;
}

export interface ListerPlan {
  list: { stock: Address; name: string; isCall: boolean; speed: number; strike: bigint; tauSeconds: number; id: Hex }[];
  setBuyable: { id: Hex; name: string }[];
  archive: { id: Hex; name: string; moneynessBps: bigint }[];
  skipped: { name: string; reason: string }[];
}

/** Pure planning step: which listings, buyable flags and archivals the chain still needs, given each name's price
 * reading and every series that exists. Idempotent by construction: a series that exists is never listed again. */
export function planListings(input: {
  stocks: readonly { name: string; stock: Address }[];
  prices: ReadonlyMap<string, PriceRead | undefined>;
  allowed: ReadonlyMap<string, boolean>;
  existing: readonly ChainSeries[];
  nowSeconds: bigint;
}): ListerPlan {
  const plan: ListerPlan = { list: [], setBuyable: [], archive: [], skipped: [] };
  // Registry ids carry the epoch (decision 27, todo 07b). Match the grid by (stock, side, strike, tau); the registry
  // returns epochs in listing order, so the last one per key is the current epoch.
  const key = (stock: string, isCall: boolean, strike: bigint, tau: number) => `${stock.toLowerCase()}:${isCall}:${strike}:${tau}`;
  const current = new Map<string, ChainSeries>();
  const epochs = new Map<string, number>();
  for (const series of input.existing) {
    const k = key(series.stock, series.isCall, series.strike, series.tauSeconds);
    current.set(k, series);
    epochs.set(k, (epochs.get(k) ?? 0) + 1);
  }
  for (const { name, stock } of input.stocks) {
    const price = input.prices.get(stock);
    if (!price || price.s === 0n) { plan.skipped.push({ name, reason: "no price reading" }); continue; }
    if (!LIVE_SESSIONS.has(price.session)) { plan.skipped.push({ name, reason: `session ${SESSION_LABEL[price.session] ?? price.session}` }); continue; }
    if (!price.fresh) { plan.skipped.push({ name, reason: "price is stale" }); continue; }
    if (price.buysPaused) { plan.skipped.push({ name, reason: "price guard has buys paused" }); continue; }
    const step = STRIKE_STEP_USD[name];
    if (!step) { plan.skipped.push({ name, reason: "no strike step configured" }); continue; }
    if (input.allowed.get(stock) === false) { plan.skipped.push({ name, reason: "stock not allowed in the registry" }); continue; }

    for (const { speed, tauSeconds } of SPEEDS) {
      for (const strike of gridStrikes(price.s, step)) {
        for (const isCall of [true, false]) {
          const k = key(stock, isCall, strike, tauSeconds);
          const found = current.get(k);
          // Nothing live at this strike, or the live epoch is archived or has decayed below the relist norm: list the next epoch.
          if (!found || found.archived || found.norm < RELIST_NORM) {
            plan.list.push({ stock, name, isCall, speed, strike, tauSeconds, id: seriesId(stock, isCall, strike, tauSeconds, epochs.get(k) ?? 0) });
          } else if (!found.buyable && input.nowSeconds - found.listedAt < RECENT_LISTING_SECONDS) {
            plan.setBuyable.push({ id: found.id, name });
          }
        }
      }
    }
    for (const series of input.existing) {
      if (series.stock !== stock || series.archived) continue;
      const away = moneynessBps(series.strike, price.s);
      if (away > BigInt(ARCHIVE_MONEYNESS_BPS)) plan.archive.push({ id: series.id, name, moneynessBps: away });
    }
  }
  return plan;
}

/** R1: keeps the strike grid listed and old strikes archived. Runs hourly but completes once per New York day: a day
 * is only marked done when every name had a live price and every transaction went through, so a closed market or a
 * stale feed simply tries again the next hour. A second run on the same day lists nothing. */
export function createListerJob(context: KeeperContext) {
  const reader = createSeriesReader(context);
  const registry = context.deployment.contracts.registry as Address;
  const priceGuard = context.deployment.contracts.priceGuard as Address;

  async function listedState(id: Hex): Promise<ChainSeries | undefined> {
    const all = await reader.readAll();
    return all.find((series) => series.id === id);
  }

  return async (options: { force?: boolean } = {}): Promise<Record<string, unknown>> => {
    const metadata = await context.metadata();
    const now = context.now(metadata);
    const today = etDate.format(now);
    const rows = await context.sql<{ meta: Record<string, unknown> }[]>`select meta from keeper_status where job = 'lister'`;
    if (!options.force && rows[0]?.meta.completedDay === today) return { skipped: "done today", completedDay: today };

    const stocks = context.deployment.stocks.map((entry) => ({ name: entry.name, stock: entry.stock as Address }));
    const reads = await context.clients.stateClient.multicall({
      allowFailure: true,
      contracts: stocks.flatMap(({ stock }) => [
        { address: priceGuard, abi: PriceGuardAbi, functionName: "read", args: [stock] },
        { address: registry, abi: SeriesRegistryAbi, functionName: "allowedStock", args: [stock] },
      ]) as never,
    }) as { status: "success" | "failure"; result?: unknown; error?: { shortMessage?: string; message?: string } }[];
    const prices = new Map<string, PriceRead | undefined>();
    const allowed = new Map<string, boolean>();
    stocks.forEach(({ stock }, index) => {
      const price = reads[index * 2];
      const allow = reads[index * 2 + 1];
      if (price?.status === "success") {
        const value = price.result as { s: bigint; session: number; fresh: boolean; buysPaused: boolean };
        prices.set(stock, { s: BigInt(value.s), session: Number(value.session), fresh: Boolean(value.fresh), buysPaused: Boolean(value.buysPaused) });
      }
      if (allow?.status === "success") allowed.set(stock, Boolean(allow.result));
      if (price?.status !== "success") context.logger.warn({ stock, err: price?.error?.shortMessage ?? price?.error?.message }, "Lister: PriceGuard.read failed");
    });

    const existing = await reader.readAll();
    const plan = planListings({ stocks, prices, allowed, existing, nowSeconds: BigInt(Math.floor(now.getTime() / 1000)) });
    const limit = context.config.KEEPER_LISTER_MAX_TX;
    let sent = 0;
    let dryRun = false;
    const listed: string[] = [];
    const archived: string[] = [];
    const failures: string[] = [];
    let remaining = 0;

    type Outcome = "sent" | "simulated" | "failed" | "capped";
    const send = async (label: string, data: Hex): Promise<Outcome> => {
      if (sent >= limit) { remaining++; return "capped"; }
      sent++;
      try {
        const result = await context.tx.submit({ label, to: registry, data });
        dryRun ||= result.simulated;
        return result.simulated ? "simulated" : "sent";
      } catch (error) {
        const summary = safeErrorSummary(error);
        // A held or unsigned queue stops everything; a single revert (strike rejected, already archived) does not.
        if (/nonce .* (is held|is unresolved|remains held)|local signer is not configured|existing pending transaction/i.test(summary.message)) throw error;
        failures.push(`${label}: ${summary.message}`);
        context.logger.warn({ label, err: summary }, "Lister transaction failed; continuing with the next series");
        return "failed";
      }
    };

    for (const item of plan.list) {
      const outcome = await send("lister:list", encodeFunctionData({
        abi: SeriesRegistryAbi, functionName: "listSeries", args: [item.stock, item.isCall, item.strike, item.tauSeconds],
      }));
      if (outcome === "sent" || outcome === "simulated") listed.push(item.id);
      if (outcome !== "sent") continue;
      // Whatever a fresh listing's default is, grid series must end up buyable.
      const state = await listedState(item.id);
      if (state && !state.buyable && !state.archived) {
        await send("lister:buyable", encodeFunctionData({ abi: SeriesRegistryAbi, functionName: "setBuyable", args: [item.id, true] }));
      }
    }
    for (const item of plan.setBuyable) {
      await send("lister:buyable", encodeFunctionData({ abi: SeriesRegistryAbi, functionName: "setBuyable", args: [item.id, true] }));
    }
    for (const item of plan.archive) {
      const outcome = await send("lister:archive", encodeFunctionData({ abi: SeriesRegistryAbi, functionName: "archive", args: [item.id] }));
      if (outcome === "sent" || outcome === "simulated") archived.push(item.id);
    }

    const complete = !plan.skipped.length && !failures.length && !remaining;
    const result: Record<string, unknown> = {
      listed: listed.length, archived: archived.length, buyableSet: plan.setBuyable.length,
      skipped: plan.skipped, failures, remaining, dryRun, completedDay: complete && !dryRun ? today : rows[0]?.meta.completedDay ?? null,
    };
    if (!complete) result.retryAfterMs = remaining ? 30_000 : 600_000;
    await saveJobMeta(context, "lister", { lastPlan: { list: plan.list.length, setBuyable: plan.setBuyable.length, archive: plan.archive.length } });
    // Surfaced as the job's error (health route, backoff) after the progress above is recorded.
    if (failures.length) throw new Error(`Lister: ${failures.length} transaction(s) failed, first: ${failures[0]}`);
    return result;
  };
}
