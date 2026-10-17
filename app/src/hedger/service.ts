import { formatUnits, type Address } from "viem";
import type { Logger } from "pino";
import { decideRehedge, type HoldReason, type TradeReason } from "./policy";
import { netDeltaFromBook, type BookSnapshot } from "./netdelta";
import { abs, toWei, type HedgerSettings, type IHedgeVenue } from "./types";

export interface HedgeRecord {
  venue: string;
  name: string;
  side: "buy" | "sell";
  qty: string;
  px: string;
  ts: Date;
  venueRef: string | null;
}

export interface HedgerState {
  lastTradeMs: Map<string, number>;
  /** venue name -> epoch ms since which it has been unhealthy. The risk monitor pauses buys after 15 minutes. */
  unhealthySince: Map<string, number>;
  /** name -> epoch ms since which the name could not be hedged (trade_failed or no_venue, e.g. no Uniswap route). */
  unhedgedSince: Map<string, number>;
}

export const newHedgerState = (): HedgerState => ({ lastTradeMs: new Map(), unhealthySince: new Map(), unhedgedSince: new Map() });

export interface CycleDeps {
  loadBook(): Promise<BookSnapshot>;
  navUsdg(): Promise<number>;
  /** Priority order: perp venues first (primary), spot last (small residuals). */
  venues: readonly IHedgeVenue[];
  record(row: HedgeRecord): Promise<void>;
  /** On-chain target source (decision 21): `engine.netGreeks(stock).delta` in stock units, the holders' long side, which
   * is exactly what the short pool must hold. Returning null means unreadable: the name is reported incomplete and
   * not traded (fail closed). When absent, the delta is priced from the indexed book instead. */
  chainDelta?(stock: Address): Promise<number | null>;
  /** Called right after the venue health check, before any other work, so the risk monitor sees a down venue even if
   * the rest of the cycle then fails. */
  onHealth?(meta: HedgerHealthMeta): Promise<void>;
  /** Called at the end of each pass with the names that could not be hedged and since when (ISO). The risk monitor pauses
   * buys on a name that stays in this list (F30). */
  onUnhedged?(unhedged: Record<string, string>): Promise<void>;
  settings: HedgerSettings;
  state: HedgerState;
  now(): number;
  logger: Logger;
}

/** What the risk monitor reads from keeper_status job 'hedger' meta. */
export interface HedgerHealthMeta {
  venueHealthy: boolean;
  venueUnhealthySince: string | null;
}

/** Healthy only when every venue is; "since" is the earliest time any venue went down. */
export function healthMeta(unhealthySince: ReadonlyMap<string, number>): HedgerHealthMeta {
  if (unhealthySince.size === 0) return { venueHealthy: true, venueUnhealthySince: null };
  return { venueHealthy: false, venueUnhealthySince: new Date(Math.min(...unhealthySince.values())).toISOString() };
}

export interface NameReport {
  name: string;
  netDelta: number;
  position: number;
  gapUnits: number;
  action: "traded" | "would_trade" | "hold" | "failed";
  reason: TradeReason | HoldReason | "incomplete_inputs" | "no_venue" | "trade_failed";
  venue?: string;
  filledUnits?: number;
  /** Delta left unhedged after this cycle, in stock units and USDG. The risk monitor reads these. */
  unhedgedUnits: number;
  unhedgedUsdg: number;
}

export interface CycleResult extends HedgerHealthMeta {
  cycleAt: string;
  dryRun: boolean;
  names: Record<string, NameReport>;
  /** Names that could not be hedged (trade_failed, no_venue) and since when. */
  unhedged: Record<string, string>;
  unhealthyVenues: Record<string, string>;
}

const asUnits = (wei: bigint): number => Number(formatUnits(wei, 18));

/** R1 + R2 + R6. One pass over every name in the book. Never throws for a single name: failures are reported. */
export async function runHedgeCycle(deps: CycleDeps): Promise<CycleResult> {
  const { settings, state, logger } = deps;
  const nowMs = deps.now();
  const health = new Map<string, boolean>();
  for (const venue of deps.venues) {
    const ok = await venue.healthy().catch(() => false);
    health.set(venue.name, ok);
    if (ok) state.unhealthySince.delete(venue.name);
    else if (!state.unhealthySince.has(venue.name)) state.unhealthySince.set(venue.name, nowMs);
  }
  const healthyVenues = deps.venues.filter((v) => health.get(v.name));
  const healthReport = healthMeta(state.unhealthySince);
  if (deps.onHealth) await deps.onHealth(healthReport).catch((error) => logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Could not record hedger health"));

  const book = await deps.loadBook();
  const exposures = netDeltaFromBook(book.series, book.markets);
  if (deps.chainDelta) {
    // The chain's own aggregate is the truth for the target. Every listed name is covered, so a name whose options
    // all expired is hedged back down to zero instead of keeping a stale position.
    for (const stock of book.markets.keys()) {
      const delta = await deps.chainDelta(stock as Address).catch(() => null);
      const entry = exposures.get(stock) ?? { stock, netDelta: 0, netGamma: 0, netVega: 0, seriesCount: 0, skipped: [], complete: true };
      entry.netDelta = delta ?? 0;
      entry.complete = delta !== null;
      exposures.set(stock, entry);
    }
  }
  const nav = await deps.navUsdg();
  const names: Record<string, NameReport> = {};

  for (const [stock, exposure] of exposures) {
    const address = stock as Address;
    const market = book.markets.get(stock);
    const label = market?.name ?? stock;
    const spot = market?.spot ?? 0;
    const report: NameReport = {
      name: label, netDelta: exposure.netDelta, position: 0, gapUnits: 0, action: "hold", reason: "incomplete_inputs",
      unhedgedUnits: 0, unhedgedUsdg: 0,
    };
    names[label] = report;
    try {
      // Total position across every venue, healthy or not: an unhealthy venue still holds its hedge.
      let position = 0n;
      for (const venue of deps.venues) position += await venue.netPosition(address).catch(() => 0n);
      report.position = asUnits(position);
      const canShort = healthyVenues.some((v) => v.canShort);
      const target = canShort ? toWei(exposure.netDelta) : toWei(Math.max(0, exposure.netDelta));
      const gap = target - position;
      report.gapUnits = asUnits(gap);
      report.unhedgedUnits = report.gapUnits;
      report.unhedgedUsdg = report.gapUnits * spot;
      if (!exposure.complete || !market) continue;

      const decision = decideRehedge({
        gapUnits: report.gapUnits, spot, navUsdg: nav, session: market.session,
        inputsFresh: market.fresh && market.tickAgeMs <= 15 * 60_000, nowMs,
        lastTradeMs: state.lastTradeMs.get(stock), bandBps: settings.bandBps, intervalSeconds: settings.intervalSeconds,
        cooldownSeconds: settings.cooldownSeconds, minTradeUsdg: settings.minTradeUsdg,
      });
      report.reason = decision.reason;
      if (!decision.trade) continue;

      const buy = gap > 0n;
      let chosen: IHedgeVenue | undefined;
      let room = 0n;
      for (const venue of healthyVenues) {
        const mine = await venue.netPosition(address).catch(() => 0n);
        if (!buy && !venue.canShort && mine <= 0n) continue;
        const cap = venue.maxTrade ? await venue.maxTrade(address, buy) : abs(gap);
        if (cap <= 0n) continue;
        chosen = venue; room = cap;
        break;
      }
      if (!chosen) { report.reason = "no_venue"; continue; }
      let size = abs(gap) < room ? abs(gap) : room;
      if (!chosen.canShort && !buy) {
        const held = await chosen.netPosition(address);
        if (size > held) size = held;
      }
      const delta = buy ? size : -size;
      report.venue = chosen.name;
      if (settings.dryRun) {
        report.action = "would_trade";
        report.filledUnits = asUnits(delta);
        report.unhedgedUnits = asUnits(gap - delta);
        report.unhedgedUsdg = report.unhedgedUnits * spot;
        logger.info({ name: label, venue: chosen.name, units: report.filledUnits, reason: decision.reason }, "Hedger dry run: would trade");
        continue;
      }
      const fill = await chosen.trade(address, delta, settings.maxSlippageBps);
      state.lastTradeMs.set(stock, nowMs);
      report.action = "traded";
      report.filledUnits = asUnits(fill.filled);
      report.unhedgedUnits = asUnits(gap - fill.filled);
      report.unhedgedUsdg = report.unhedgedUnits * spot;
      if (fill.filled !== 0n) {
        await deps.record({
          venue: chosen.name, name: label, side: fill.filled > 0n ? "buy" : "sell",
          qty: formatUnits(abs(fill.filled), 18), px: formatUnits(fill.px, 6), ts: new Date(nowMs), venueRef: fill.ref || null,
        });
      }
    } catch (error) {
      report.action = "failed";
      report.reason = "trade_failed";
      logger.warn({ name: label, err: error instanceof Error ? error.message : String(error) }, "Hedge failed for this name; will retry next cycle");
    }
  }

  for (const [label, report] of Object.entries(names)) {
    if (report.reason === "trade_failed" || report.reason === "no_venue") {
      if (!state.unhedgedSince.has(label)) state.unhedgedSince.set(label, nowMs);
    } else state.unhedgedSince.delete(label);
  }
  for (const label of [...state.unhedgedSince.keys()]) if (!(label in names)) state.unhedgedSince.delete(label);
  const unhedged = Object.fromEntries([...state.unhedgedSince].map(([label, since]) => [label, new Date(since).toISOString()]));
  if (deps.onUnhedged) await deps.onUnhedged(unhedged).catch((error) => logger.warn({ err: error instanceof Error ? error.message : String(error) }, "Could not record unhedged names"));
  if (Object.keys(unhedged).length) logger.error({ unhedged }, "Hedger cannot hedge these names; the risk monitor will pause their buys");

  return {
    cycleAt: new Date(nowMs).toISOString(), dryRun: settings.dryRun, names, unhedged, ...healthMeta(state.unhealthySince),
    unhealthyVenues: Object.fromEntries([...state.unhealthySince].map(([name, since]) => [name, new Date(since).toISOString()])),
  };
}

