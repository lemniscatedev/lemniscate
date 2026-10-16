import type { QueryDeps } from "./series";

export interface PoolNavRow {
  ts: string;
  block: string;
  usdg: string;
  hedgeEquity: string;
  optionLiability: string;
  reserve: string;
  nav: string;
  navPerShare: string;
}

interface PoolNavDbRow {
  ts: Date | string; block: string; usdg: string; hedge_equity: string; option_liability: string; reserve: string; nav: string; nav_per_share: string;
}

const toNav = (row: PoolNavDbRow): PoolNavRow => ({
  ts: new Date(row.ts).toISOString(), block: String(row.block), usdg: row.usdg, hedgeEquity: row.hedge_equity,
  optionLiability: row.option_liability, reserve: row.reserve, nav: row.nav, navPerShare: row.nav_per_share,
});

export async function latestPoolNav(deps: QueryDeps): Promise<PoolNavRow | null> {
  const rows = (await deps.sql`
    SELECT ts, block, usdg, hedge_equity, option_liability, reserve, nav, nav_per_share FROM pool_nav ORDER BY ts DESC LIMIT 1
  `) as unknown as PoolNavDbRow[];
  return rows[0] ? toNav(rows[0]) : null;
}

/** Snapshots since `since`, oldest first. */
export async function poolNavHistory(deps: QueryDeps, since: Date, limit = 2_000): Promise<PoolNavRow[]> {
  const rows = (await deps.sql`
    SELECT ts, block, usdg, hedge_equity, option_liability, reserve, nav, nav_per_share FROM pool_nav
    WHERE ts >= ${since.toISOString()} ORDER BY ts ASC LIMIT ${Math.min(Math.max(limit, 1), 10_000)}
  `) as unknown as PoolNavDbRow[];
  return rows.map(toNav);
}

export interface LimitsRow {
  name: string;
  ts: string;
  netDelta: string;
  netGamma: string;
  netVega: string;
  stressLossBps: string;
}

/** The newest limits_state row of every name. */
export async function latestLimits(deps: QueryDeps): Promise<LimitsRow[]> {
  const rows = (await deps.sql`
    SELECT DISTINCT ON (name) name, ts, net_delta, net_gamma, net_vega, stress_loss_bps
    FROM limits_state ORDER BY name, ts DESC
  `) as unknown as { name: string; ts: Date | string; net_delta: string; net_gamma: string; net_vega: string; stress_loss_bps: string }[];
  return rows.map((row) => ({
    name: row.name, ts: new Date(row.ts).toISOString(), netDelta: row.net_delta, netGamma: row.net_gamma,
    netVega: row.net_vega, stressLossBps: row.stress_loss_bps,
  }));
}

export interface WithdrawalRow {
  owner: string;
  ticket: string;
  shares: string;
  claimableAt: string;
  status: "queued" | "claimed";
  usdg: string | null;
}

/** Unclaimed pool withdrawal tickets, soonest claimable first. */
export async function queuedWithdrawals(deps: QueryDeps, owner?: string): Promise<WithdrawalRow[]> {
  const who = owner?.toLowerCase() ?? null;
  const rows = (await deps.sql`
    SELECT owner, ticket, shares, claimable_at, status, usdg FROM withdrawals
    WHERE status = 'queued' AND (${who}::text IS NULL OR owner = ${who}) ORDER BY claimable_at, ticket
  `) as unknown as { owner: string; ticket: string; shares: string; claimable_at: Date | string; status: "queued" | "claimed"; usdg: string | null }[];
  return rows.map((row) => ({
    owner: row.owner, ticket: row.ticket, shares: row.shares, claimableAt: new Date(row.claimable_at).toISOString(),
    status: row.status, usdg: row.usdg,
  }));
}

export interface QueuedSellRow {
  ticket: string;
  seriesId: string;
  seller: string;
  recipient: string;
  tokens: string;
  queuedAt: string;
}

/** Sells waiting for the first fresh price. */
export async function openQueuedSells(deps: QueryDeps, seller?: string): Promise<QueuedSellRow[]> {
  const who = seller?.toLowerCase() ?? null;
  const rows = (await deps.sql`
    SELECT ticket, series_id, seller, recipient, tokens, queued_at FROM queued_sells
    WHERE status = 'open' AND (${who}::text IS NULL OR seller = ${who}) ORDER BY ticket
  `) as unknown as { ticket: string; series_id: string; seller: string; recipient: string; tokens: string; queued_at: Date | string }[];
  return rows.map((row) => ({
    ticket: row.ticket, seriesId: row.series_id, seller: row.seller, recipient: row.recipient, tokens: row.tokens,
    queuedAt: new Date(row.queued_at).toISOString(),
  }));
}

export interface VolPostRow {
  name: string | null;
  speed: "DAILY" | "WEEKLY";
  sigmaBps: number;
  skewK: string;
  eventBumpBps: number;
  buyBlockFrom: string | null;
  buyBlockTo: string | null;
  validUntil: string;
  ts: string;
}

/** The latest post per name and speed, as the engine would read it. */
export async function latestVolPosts(deps: QueryDeps): Promise<VolPostRow[]> {
  const rows = (await deps.sql`
    SELECT DISTINCT ON (stock_token, speed) name, speed, sigma_bps, skew_k, event_bump_bps, buy_block_from, buy_block_to, valid_until, ts
    FROM vol_posts ORDER BY stock_token, speed, ts DESC, log_index DESC
  `) as unknown as {
    name: string | null; speed: "DAILY" | "WEEKLY"; sigma_bps: number; skew_k: string; event_bump_bps: number;
    buy_block_from: Date | string | null; buy_block_to: Date | string | null; valid_until: Date | string; ts: Date | string;
  }[];
  const opt = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());
  return rows.map((row) => ({
    name: row.name, speed: row.speed, sigmaBps: row.sigma_bps, skewK: row.skew_k, eventBumpBps: row.event_bump_bps,
    buyBlockFrom: opt(row.buy_block_from), buyBlockTo: opt(row.buy_block_to), validUntil: new Date(row.valid_until).toISOString(),
    ts: new Date(row.ts).toISOString(),
  }));
}
