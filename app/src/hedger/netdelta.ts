import { YEAR_S } from "../pricing";
import { callGreeks, putGreeks } from "../pricing/greeks";
import type { LemniscateDbClient } from "../db/client";
import type { Speed } from "./types";

/** One series of the pool's short book. `units` = outstanding supply x norm (what the engine owes holders). */
export interface BookSeries {
  id: string;
  stock: string;
  isCall: boolean;
  strike: number;
  tauS: number;
  speed: Speed;
  units: number;
}

export interface NameMarket {
  name: string;
  spot: number;
  session: string;
  fresh: boolean;
  tickAgeMs: number;
  /** sigma as a fraction, per speed (from the posted vol, bps / 10000). */
  sigma: Partial<Record<Speed, number>>;
}

export interface NameExposure {
  stock: string;
  /** Stock tokens the pool should HOLD long to be delta neutral: sum(units x option delta) over the pool's short series.
   * Short calls need positive stock, short puts negative; the net can be negative (spot cannot go there). */
  netDelta: number;
  netGamma: number;
  netVega: number;
  seriesCount: number;
  /** Series that could not be priced (no tick, sigma or spot); a name with any is `complete: false`. */
  skipped: string[];
  complete: boolean;
}

/** R1. Net delta per name from the indexed book, using the TS Greeks. Pure. */
export function netDeltaFromBook(series: readonly BookSeries[], markets: ReadonlyMap<string, NameMarket>): Map<string, NameExposure> {
  const out = new Map<string, NameExposure>();
  for (const s of series) {
    if (!(s.units > 0)) continue;
    const entry = out.get(s.stock)
      ?? { stock: s.stock, netDelta: 0, netGamma: 0, netVega: 0, seriesCount: 0, skipped: [], complete: true };
    out.set(s.stock, entry);
    const market = markets.get(s.stock);
    const sigma = market?.sigma[s.speed];
    if (!market || !(market.spot > 0) || sigma === undefined || !(sigma > 0)) {
      entry.skipped.push(s.id);
      entry.complete = false;
      continue;
    }
    const greeks = (s.isCall ? callGreeks : putGreeks)(market.spot, s.strike, sigma, s.tauS / YEAR_S);
    entry.netDelta += s.units * greeks.delta;
    entry.netGamma += s.units * greeks.gamma;
    entry.netVega += s.units * greeks.vega;
    entry.seriesCount++;
  }
  return out;
}

export interface BookSnapshot {
  series: BookSeries[];
  markets: Map<string, NameMarket>;
}

const bps = (value: number | null | undefined): number | undefined =>
  value === null || value === undefined ? undefined : Number(value) / 10_000;

/** Reads the book from the indexer tables: series x supply x norm, latest tick per stock. */
export async function loadBook(sql: LemniscateDbClient["sql"], now = Date.now()): Promise<BookSnapshot> {
  const seriesRows = await sql<{ id: string; stock_token: string; is_call: boolean; speed: string; tau_s: number; strike: string; norm: string; supply: string }[]>`
    select s.id, s.stock_token, s.is_call, s.speed, s.tau_s, s.strike::text as strike, s.norm::text as norm,
      coalesce((select sum(b.balance) from balances b where b.token = s.token), 0)::text as supply
    from series s`;
  const tickRows = await sql<{ stock_token: string; name: string | null; spot: string; session: string; fresh: boolean; ts: Date; sigma_daily_bps: number | null; sigma_weekly_bps: number | null }[]>`
    select distinct on (stock_token) stock_token, name, spot::text as spot, session, fresh, ts, sigma_daily_bps, sigma_weekly_bps
    from ticks order by stock_token, ts desc`;
  const markets = new Map<string, NameMarket>();
  for (const t of tickRows) {
    const sigma: Partial<Record<Speed, number>> = {};
    const daily = bps(t.sigma_daily_bps);
    const weekly = bps(t.sigma_weekly_bps);
    if (daily !== undefined) sigma.DAILY = daily;
    if (weekly !== undefined) sigma.WEEKLY = weekly;
    markets.set(t.stock_token, {
      name: t.name ?? t.stock_token, spot: Number(t.spot), session: t.session, fresh: t.fresh,
      tickAgeMs: now - new Date(t.ts).getTime(), sigma,
    });
  }
  const series: BookSeries[] = seriesRows
    .map((r) => ({
      id: r.id, stock: r.stock_token, isCall: r.is_call, strike: Number(r.strike), tauS: r.tau_s,
      speed: (r.speed.toUpperCase() === "WEEKLY" ? "WEEKLY" : "DAILY") as Speed,
      units: Number(r.supply) * Number(r.norm),
    }))
    .filter((s) => s.units > 0);
  return { series, markets };
}
