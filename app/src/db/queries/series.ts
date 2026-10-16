import type { Sql } from "postgres";

/** Queries take only the database handle, so the API, the keepers and the vol engine bridge can all use them. */
export interface QueryDeps {
  readonly sql: Sql;
}

export interface SeriesView {
  id: string;
  stock: string;
  name: string | null;
  feed: string | null;
  isCall: boolean;
  speed: "DAILY" | "WEEKLY";
  tauSeconds: number;
  /** WAD USDG per whole Stock Token, as a decimal string. */
  strike: string;
  token: string;
  /** Funding factor, starts at 1 and only falls. Holder units = balance x norm. */
  norm: string;
  lastAccrual: string;
  buyable: boolean;
  archived: boolean;
  listedAt: string;
}

interface SeriesDbRow {
  id: string;
  stock_token: string;
  name: string | null;
  feed: string | null;
  is_call: boolean;
  speed: "DAILY" | "WEEKLY";
  tau_s: number;
  strike: string;
  token: string;
  norm: string;
  last_accrual: Date | string;
  buyable: boolean;
  archived: boolean;
  listed_at: Date | string;
}

const iso = (value: Date | string): string => new Date(value).toISOString();

export function toSeriesView(row: SeriesDbRow): SeriesView {
  return {
    id: row.id,
    stock: row.stock_token,
    name: row.name,
    feed: row.feed,
    isCall: row.is_call,
    speed: row.speed,
    tauSeconds: row.tau_s,
    strike: row.strike,
    token: row.token,
    norm: row.norm,
    lastAccrual: iso(row.last_accrual),
    buyable: row.buyable,
    archived: row.archived,
    listedAt: iso(row.listed_at),
  };
}

export interface SeriesFilter {
  readonly name?: string;
  readonly speed?: "DAILY" | "WEEKLY";
  readonly includeArchived?: boolean;
}

/** The strike grid of a name, ordered by speed, then strike, calls before puts at the same strike. */
export async function listSeries(deps: QueryDeps, filter: SeriesFilter = {}): Promise<SeriesView[]> {
  const rows = (await deps.sql`
    SELECT id, stock_token, name, feed, is_call, speed, tau_s, strike, token, norm, last_accrual, buyable, archived, listed_at
    FROM series
    WHERE (${filter.name ?? null}::text IS NULL OR name = ${filter.name ?? null})
      AND (${filter.speed ?? null}::text IS NULL OR speed = ${filter.speed ?? null})
      AND (${filter.includeArchived ?? false} OR archived = false)
    ORDER BY name, speed, strike, is_call DESC, id
  `) as unknown as SeriesDbRow[];
  return rows.map(toSeriesView);
}

export async function getSeries(deps: QueryDeps, id: string): Promise<SeriesView | null> {
  const rows = (await deps.sql`
    SELECT id, stock_token, name, feed, is_call, speed, tau_s, strike, token, norm, last_accrual, buyable, archived, listed_at
    FROM series WHERE id = ${id.toLowerCase()}
  `) as unknown as SeriesDbRow[];
  return rows[0] ? toSeriesView(rows[0]) : null;
}

export interface ListedName {
  name: string;
  /** At least one of its series can be bought right now. */
  buyable: boolean;
}

/** Names that have at least one series listed. */
export async function listedNames(deps: QueryDeps): Promise<ListedName[]> {
  const rows = (await deps.sql`
    SELECT name, bool_or(buyable AND NOT archived) AS buyable
    FROM series WHERE name IS NOT NULL GROUP BY name ORDER BY name
  `) as unknown as { name: string; buyable: boolean }[];
  return rows.map((row) => ({ name: row.name, buyable: row.buyable }));
}

export interface NormPoint {
  ts: string;
  norm: string;
  vMark: string;
  payoff: string;
  session: string;
}

/** Funding history of one series, newest first. */
export async function normHistory(deps: QueryDeps, seriesId: string, limit = 500): Promise<NormPoint[]> {
  const rows = (await deps.sql`
    SELECT ts, norm, v_mark, payoff, session FROM norm_history
    WHERE series_id = ${seriesId.toLowerCase()} ORDER BY ts DESC, log_index DESC LIMIT ${Math.min(Math.max(limit, 1), 5_000)}
  `) as unknown as { ts: Date | string; norm: string; v_mark: string; payoff: string; session: string }[];
  return rows.map((row) => ({ ts: iso(row.ts), norm: row.norm, vMark: row.v_mark, payoff: row.payoff, session: row.session }));
}
