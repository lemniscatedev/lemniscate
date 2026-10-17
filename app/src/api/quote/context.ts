import type { ApiDependencies } from "../types";
import { enginePauses, latestTick, seriesSupply, type PauseState, type TickRow } from "../../db/queries/market";
import { latestLimits, latestPoolNav, latestVolPosts, type VolPostRow } from "../../db/queries/pool";
import { listSeries, type SeriesView } from "../../db/queries/series";
import { unitQuote, type MarketInputs, type SeriesInputs, type Speed } from "./model";
import { computeKindedSessions, SESSION_REGULAR, type KindedSession } from "../../keeper/sessions";

/** The session at the API clock. The indexed tick carries PriceGuard's session at its last snapshot (on events and
 * every ten minutes), so right after a session boundary it is stale: on the fork a weekend sell was quoted at the
 * regular spread (the engine applies 3x) and reverted on Slippage; on mainnet the same happens for a few minutes after
 * each open and close. When a boundary of the NYSE calendar (the one the keeper pushes to MarketHours) lies between the
 * tick and now, the calendar decides; a HALTED reading stays HALTED inside live hours (a feed problem does not end at
 * the bell). Otherwise the indexed session stands. */
export function sessionNow(tick: Pick<TickRow, "session" | "ts">, nowMs: number): TickRow["session"] {
  const tickMs = Date.parse(tick.ts);
  if (!Number.isFinite(tickMs) || nowMs <= tickMs) return tick.session;
  let sessions: KindedSession[];
  try { sessions = computeKindedSessions(new Date(tickMs), 30); } catch { return tick.session; }
  const at = (ms: number) => {
    const t = BigInt(Math.floor(ms / 1000));
    return sessions.find((s) => s.open <= t && t < s.close) ?? null;
  };
  const was = at(tickMs);
  const is = at(nowMs);
  if (was === is || (was && is && was.open === is.open && was.close === is.close)) return tick.session;
  if (!is) return "CLOSED";
  if (tick.session === "HALTED") return "HALTED";
  return is.kind === SESSION_REGULAR ? "REGULAR" : "EXTENDED";
}

/** Everything the quote model needs about one name, read once from Postgres (never from an RPC). */
export interface NameContext {
  readonly name: string;
  readonly tick: TickRow;
  readonly nowMs: number;
  readonly vol: Readonly<Record<Speed, VolPostRow | undefined>>;
  readonly pauses: PauseState;
  /** Pool NAV, the name's vega and outstanding values, from the indexer's latest snapshot (up to ~10 minutes old:
   * the inventory term and the cap checks use it as is). Null before the first pool snapshot. */
  readonly book: NameBook | null;
}

export interface NameBook {
  readonly navUsd: number;
  /** limits_state.net_vega: the engine's netGreeks vega, the holders' long side (decision 21), USDG per vol point. */
  readonly nameVegaUsd: number;
  /** pool_nav.option_liability: outstanding option value of the whole book. */
  readonly totalValueUsd: number;
  readonly nameValueUsd: number;
  /** Outstanding option value per series id (supply x norm x mark). */
  readonly seriesValueUsd: ReadonlyMap<string, number>;
}

export async function loadNameContext(deps: ApiDependencies, name: string, now: Date): Promise<NameContext | null> {
  const [tick, posts, pauses, nav, limits, series, supplies] = await Promise.all([
    latestTick(deps, name), latestVolPosts(deps), enginePauses(deps), latestPoolNav(deps), latestLimits(deps),
    listSeries(deps, { name, includeArchived: true }), seriesSupply(deps, name),
  ]);
  if (!tick) return null;
  const ofName = posts.filter((post) => post.name === name);
  const base: NameContext = {
    name,
    tick: { ...tick, session: sessionNow(tick, now.getTime()) },
    nowMs: now.getTime(),
    vol: { DAILY: ofName.find((p) => p.speed === "DAILY"), WEEKLY: ofName.find((p) => p.speed === "WEEKLY") },
    pauses,
    book: null,
  };
  if (!nav) return base;
  const supplyOf = new Map(supplies.map((row) => [row.seriesId, Number(row.supply)]));
  const seriesValueUsd = new Map<string, number>();
  let nameValueUsd = 0;
  for (const item of series) {
    const unit = unitQuote(seriesInputs(item), marketInputs(base, item), false);
    const value = unit ? (supplyOf.get(item.id) ?? 0) * Number(item.norm) * unit.v : 0;
    seriesValueUsd.set(item.id, value);
    nameValueUsd += value;
  }
  return {
    ...base,
    book: {
      navUsd: Number(nav.nav),
      nameVegaUsd: Number(limits.find((row) => row.name === name)?.netVega ?? 0),
      totalValueUsd: Number(nav.optionLiability),
      nameValueUsd,
      seriesValueUsd,
    },
  };
}

export function volAgeSeconds(post: VolPostRow | undefined, nowMs: number): number | null {
  return post ? Math.max(0, Math.round((nowMs - new Date(post.ts).getTime()) / 1_000)) : null;
}

/** Market inputs for one series of this name. */
export function marketInputs(ctx: NameContext, series: Pick<SeriesView, "id" | "speed">): MarketInputs {
  const post = ctx.vol[series.speed];
  const other = ctx.vol[series.speed === "DAILY" ? "WEEKLY" : "DAILY"];
  const windowOf = (p: VolPostRow | undefined) => (p?.buyBlockFrom && p.buyBlockTo
    ? { from: new Date(p.buyBlockFrom).getTime(), to: new Date(p.buyBlockTo).getTime() }
    : null);
  const block = windowOf(post) ?? windowOf(other);
  return {
    spot: Number(ctx.tick.spot),
    session: ctx.tick.session,
    fresh: ctx.tick.fresh,
    priceBuysPaused: ctx.tick.buysPaused,
    engineBuysPaused: ctx.pauses.global || ctx.pauses.series.has(series.id.toLowerCase()),
    sigmaBps: post ? post.sigmaBps : null,
    skewK: post ? BigInt(post.skewK.split(".")[0] || "0") : 0n,
    volStale: post ? ctx.nowMs > new Date(post.validUntil).getTime() : true,
    buyBlockFromMs: block?.from ?? null,
    buyBlockToMs: block?.to ?? null,
    nowMs: ctx.nowMs,
    ...(ctx.book
      ? {
        book: {
          navUsd: ctx.book.navUsd, nameVegaUsd: ctx.book.nameVegaUsd, totalValueUsd: ctx.book.totalValueUsd,
          nameValueUsd: ctx.book.nameValueUsd,
          ...(ctx.book.seriesValueUsd.has(series.id) ? { seriesValueUsd: ctx.book.seriesValueUsd.get(series.id)! } : {}),
        },
      }
      : {}),
  };
}

export function seriesInputs(series: SeriesView): SeriesInputs {
  return { isCall: series.isCall, speed: series.speed, strike: Number(series.strike), buyable: series.buyable, archived: series.archived };
}
