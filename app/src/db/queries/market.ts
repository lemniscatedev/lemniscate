import type { QueryDeps } from "./series";

export interface TickRow {
  name: string;
  stock: string;
  ts: string;
  /** Underlying price, USDG per whole Stock Token. */
  spot: string;
  session: "REGULAR" | "EXTENDED" | "CLOSED" | "UNKNOWN" | "HALTED";
  fresh: boolean;
  buysPaused: boolean;
  priceUpdatedAt: string | null;
  /** PriceGuard.tradeTwap at the snapshot (decision 30), or null when unavailable. */
  tradeTwap?: string | null;
  /** engine.settlePrice: ORC-4 settlement price (decision 31), or null. */
  settlePrice?: string | null;
  /** PriceGuard.haltedSince, or null when no halt is latched. */
  haltedSince?: string | null;
}

interface TickDbRow {
  name: string; stock_token: string; ts: Date | string; spot: string; session: TickRow["session"]; fresh: boolean;
  buys_paused: boolean; price_updated_at: Date | string | null;
  trade_twap?: string | null; settle_price?: string | null; halted_since?: Date | string | null;
}

const toTick = (row: TickDbRow): TickRow => ({
  name: row.name, stock: row.stock_token, ts: new Date(row.ts).toISOString(), spot: row.spot, session: row.session,
  fresh: row.fresh, buysPaused: row.buys_paused,
  priceUpdatedAt: row.price_updated_at === null ? null : new Date(row.price_updated_at).toISOString(),
  tradeTwap: row.trade_twap ?? null,
  settlePrice: row.settle_price ?? null,
  haltedSince: row.halted_since ? new Date(row.halted_since).toISOString() : null,
});

/** Hold length when no snapshot has stored the engine's configured one (EngineCore.DEFAULT_HOLD). */
const DEFAULT_HOLD_SECONDS = 1_800;

/** The account's open sell hold on a series (decision 30). The indexed `holds` row is the engine's own reading, but the
 * snapshot lags the chain: a buy since then is read from `trades` (hold = buy time + hold seconds, buy-time trade S from
 * the tick at that time: the worse of the feed S and the trade TWAP for the buyer). The engine keeps the later end and
 * the more binding S across re-buys, so the two sources are merged the same way. `isCall` picks the more binding side
 * (a call seller is hurt by the lower S, a put seller by the higher). */
export async function activeHold(deps: QueryDeps, seriesId: string, account: string, now: Date, isCall = true): Promise<{ s: string; until: string; tokens: string | null } | null> {
  const nowIso = now.toISOString();
  const read = (await deps.sql`
    SELECT s::text AS s, until, block::text AS block, tokens::text AS tokens FROM holds
    WHERE series_id = ${seriesId.toLowerCase()} AND account = ${account.toLowerCase()} AND until > ${nowIso}
  `) as unknown as { s: string; until: Date | string; block: string; tokens: string | null }[];
  const recent = (await deps.sql`
    SELECT t.ts, t.block::text AS block, t.shares::text AS shares,
      (SELECT hold_seconds FROM pool_nav WHERE hold_seconds IS NOT NULL ORDER BY ts DESC LIMIT 1) AS hold_seconds,
      tk.spot::text AS spot, tk.trade_twap::text AS twap
    FROM trades t
    JOIN series sr ON sr.id = t.series_id
    LEFT JOIN LATERAL (
      SELECT spot, trade_twap FROM ticks WHERE name = sr.name AND ts <= t.ts ORDER BY ts DESC LIMIT 1
    ) tk ON true
    WHERE t.series_id = ${seriesId.toLowerCase()} AND t.recipient = ${account.toLowerCase()} AND t.side = 'buy'
      AND t.ts > ${new Date(now.getTime() - 86_400_000).toISOString()}
    ORDER BY t.ts DESC
  `) as unknown as { ts: Date | string; block: string; shares: string; hold_seconds: number | null; spot: string | null; twap: string | null }[];

  let found: { s: number | null; untilMs: number } | null = null;
  const binding = (a: number | null, b: number | null): number | null =>
    (a === null ? b : b === null ? a : isCall ? Math.min(a, b) : Math.max(a, b));
  const merge = (s: number | null, untilMs: number): void => {
    found = found ? { s: binding(found.s, s), untilMs: Math.max(found.untilMs, untilMs) } : { s, untilMs };
  };
  // R02 (decision 54): the hold binds only the tokens the account's own buys minted. The snapshot's count, plus the tokens of
  // buys after the snapshot's block (or of every open buy when there is no row); sells since then are not subtracted, so the
  // count can only be too high, which prices the quote lower (the safe side for minProceeds). A row from before the token
  // count was stored (null) leaves every token held.
  const indexed = read[0];
  let tokens: number | null = indexed ? (indexed.tokens === null ? null : Number(indexed.tokens)) : 0;
  for (const row of read) merge(Number(row.s), new Date(row.until).getTime());
  for (const row of recent) {
    const untilMs = new Date(row.ts).getTime() + 1_000 * (row.hold_seconds ?? DEFAULT_HOLD_SECONDS);
    if (untilMs <= now.getTime()) continue;
    if (tokens !== null && (!indexed || BigInt(row.block) > BigInt(indexed.block))) tokens += Number(row.shares);
    // A buy's S is the worse for a buyer: the higher of feed and TWAP for a call, the lower for a put.
    const spot = row.spot === null ? null : Number(row.spot);
    const twap = row.twap === null ? 0 : Number(row.twap);
    merge(spot === null ? null : (twap > 0 ? (isCall ? Math.max(spot, twap) : Math.min(spot, twap)) : spot), untilMs);
  }
  const hold = found as { s: number | null; untilMs: number } | null;
  // A hold whose buy-time S is unknown (no tick before the buy) cannot be priced: show none rather than a guess.
  if (!hold || hold.s === null || !(hold.s > 0)) return null;
  return { s: String(hold.s), until: new Date(hold.untilMs).toISOString(), tokens: tokens === null ? null : String(tokens) };
}

/** The newest price tick of one name, or null when nothing has been indexed for it. */
export async function latestTick(deps: QueryDeps, name: string): Promise<TickRow | null> {
  const rows = (await deps.sql`
    SELECT name, stock_token, ts, spot, session, fresh, buys_paused, price_updated_at,
           trade_twap::text AS trade_twap, settle_price::text AS settle_price, halted_since
    FROM ticks WHERE name = ${name} ORDER BY ts DESC LIMIT 1
  `) as unknown as TickDbRow[];
  return rows[0] ? toTick(rows[0]) : null;
}

/** The newest tick of every name. */
export async function latestTicks(deps: QueryDeps): Promise<TickRow[]> {
  const rows = (await deps.sql`
    SELECT DISTINCT ON (name) name, stock_token, ts, spot, session, fresh, buys_paused, price_updated_at,
           trade_twap::text AS trade_twap, settle_price::text AS settle_price, halted_since
    FROM ticks WHERE name IS NOT NULL ORDER BY name, ts DESC
  `) as unknown as TickDbRow[];
  return rows.map(toTick);
}

export interface PauseState {
  /** The engine's global buy pause is on. */
  readonly global: boolean;
  /** Series ids with an engine-level buy pause. */
  readonly series: ReadonlySet<string>;
}

/** Current engine pauses, from the newest pause_log row of every scope and key. */
export async function enginePauses(deps: QueryDeps): Promise<PauseState> {
  const rows = (await deps.sql`
    SELECT DISTINCT ON (scope, key) scope, key, paused FROM pause_log
    WHERE scope IN ('global', 'series') ORDER BY scope, key, block DESC, log_index DESC
  `) as unknown as { scope: string; key: string; paused: boolean }[];
  return {
    global: rows.some((row) => row.scope === "global" && row.paused),
    series: new Set(rows.filter((row) => row.scope === "series" && row.paused).map((row) => row.key.toLowerCase())),
  };
}

export interface VolHistoryRow {
  speed: "DAILY" | "WEEKLY";
  sigmaBps: number;
  skewK: string;
  eventBumpBps: number;
  buyBlockFrom: string | null;
  buyBlockTo: string | null;
  validUntil: string;
  ts: string;
}

/** Vol posts of one name, newest first. */
export async function volPostHistory(deps: QueryDeps, name: string, limit = 50): Promise<VolHistoryRow[]> {
  const rows = (await deps.sql`
    SELECT speed, sigma_bps, skew_k, event_bump_bps, buy_block_from, buy_block_to, valid_until, ts FROM vol_posts
    WHERE name = ${name} ORDER BY ts DESC, log_index DESC LIMIT ${Math.min(Math.max(limit, 1), 500)}
  `) as unknown as {
    speed: "DAILY" | "WEEKLY"; sigma_bps: number; skew_k: string; event_bump_bps: number;
    buy_block_from: Date | string | null; buy_block_to: Date | string | null; valid_until: Date | string; ts: Date | string;
  }[];
  const opt = (value: Date | string | null) => (value === null ? null : new Date(value).toISOString());
  return rows.map((row) => ({
    speed: row.speed, sigmaBps: row.sigma_bps, skewK: row.skew_k, eventBumpBps: row.event_bump_bps,
    buyBlockFrom: opt(row.buy_block_from), buyBlockTo: opt(row.buy_block_to),
    validUntil: new Date(row.valid_until).toISOString(), ts: new Date(row.ts).toISOString(),
  }));
}

export interface OutstandingRow {
  seriesId: string;
  /** Option-token supply (mints minus burns), 18 dp. */
  supply: string;
}

/** Token supply of every series, from the transfer ledger (mints come from the zero address, burns go to it). */
export async function seriesSupply(deps: QueryDeps, name?: string): Promise<OutstandingRow[]> {
  const rows = (await deps.sql`
    SELECT series_id,
           COALESCE(SUM(CASE WHEN from_addr = '0x0000000000000000000000000000000000000000' THEN amount ELSE 0 END), 0)
         - COALESCE(SUM(CASE WHEN to_addr = '0x0000000000000000000000000000000000000000' THEN amount ELSE 0 END), 0) AS supply
    FROM transfers WHERE series_id IS NOT NULL
      AND (${name ?? null}::text IS NULL OR series_id IN (SELECT id FROM series WHERE name = ${name ?? null}))
    GROUP BY series_id
  `) as unknown as { series_id: string; supply: string }[];
  return rows.map((row) => ({ seriesId: row.series_id, supply: row.supply }));
}

export interface HedgeEquityRow {
  equityUsdg: string;
  asOf: string;
  postedAt: string;
}

export async function latestHedgeEquity(deps: QueryDeps): Promise<HedgeEquityRow | null> {
  const rows = (await deps.sql`
    SELECT equity_usdg, as_of, ts FROM hedge_equity_posts ORDER BY ts DESC, log_index DESC LIMIT 1
  `) as unknown as { equity_usdg: string; as_of: Date | string; ts: Date | string }[];
  return rows[0]
    ? { equityUsdg: rows[0].equity_usdg, asOf: new Date(rows[0].as_of).toISOString(), postedAt: new Date(rows[0].ts).toISOString() }
    : null;
}

/** Highest NAV per share in the window, for the 30 day drawdown figure. */
export async function peakNavPerShare(deps: QueryDeps, since: Date): Promise<string | null> {
  const rows = (await deps.sql`
    SELECT MAX(nav_per_share) AS peak FROM pool_nav WHERE ts >= ${since.toISOString()}
  `) as unknown as { peak: string | null }[];
  return rows[0]?.peak ?? null;
}

export interface QueueSummary {
  withdrawals: number;
  withdrawalShares: string;
  sells: number;
}

export async function queueSummary(deps: QueryDeps): Promise<QueueSummary> {
  const [w, s] = await Promise.all([
    deps.sql`SELECT COUNT(*)::int AS n, COALESCE(SUM(shares), 0) AS shares FROM withdrawals WHERE status = 'queued'`,
    deps.sql`SELECT COUNT(*)::int AS n FROM queued_sells WHERE status = 'open'`,
  ]) as unknown as [{ n: number; shares: string }[], { n: number }[]];
  return { withdrawals: w[0]?.n ?? 0, withdrawalShares: w[0]?.shares ?? "0", sells: s[0]?.n ?? 0 };
}

export interface WriterTotals {
  depositedUsdg: string;
  claimedUsdg: string;
  wallets: number;
}

/** Writer Pool flows from the indexed Deposit and Withdraw events: USDG deposited and paid out by claims, and how many
 * wallets ever deposited (zero-seed launch: the /writers page shows the pool filling from the public). */
export async function writerTotals(deps: QueryDeps): Promise<WriterTotals> {
  const rows = await deps.sql`
    SELECT COALESCE(SUM(assets) FILTER (WHERE kind = 'deposit'), 0) AS deposited,
      COALESCE(SUM(assets) FILTER (WHERE kind = 'withdraw'), 0) AS claimed,
      COUNT(DISTINCT account) FILTER (WHERE kind = 'deposit')::int AS wallets
    FROM pool_events` as unknown as { deposited: string; claimed: string; wallets: number }[];
  return { depositedUsdg: String(rows[0]?.deposited ?? "0"), claimedUsdg: String(rows[0]?.claimed ?? "0"), wallets: rows[0]?.wallets ?? 0 };
}

export interface FundingWindowRow {
  seriesId: string;
  normNow: string;
  /** Norm at the start of the window (1 for a series listed inside it). */
  normThen: string;
  /** The newest mark per unit recorded at an accrual, or null before the first one. */
  vMark: string | null;
}

/** Norm at the start of the window and now, per series: what funding took from holders in between. */
export async function fundingWindow(deps: QueryDeps, since: Date): Promise<FundingWindowRow[]> {
  const rows = (await deps.sql`
    SELECT s.id AS series_id, s.norm AS norm_now,
      COALESCE((SELECT h.norm FROM norm_history h WHERE h.series_id = s.id AND h.ts <= ${since.toISOString()} ORDER BY h.ts DESC, h.log_index DESC LIMIT 1), 1) AS norm_then,
      (SELECT h.v_mark FROM norm_history h WHERE h.series_id = s.id ORDER BY h.ts DESC, h.log_index DESC LIMIT 1) AS v_mark
    FROM series s WHERE s.archived = false OR EXISTS (SELECT 1 FROM balances b WHERE b.token = s.token AND b.balance > 0)
  `) as unknown as { series_id: string; norm_now: string; norm_then: string; v_mark: string | null }[];
  return rows.map((row) => ({ seriesId: row.series_id, normNow: row.norm_now, normThen: row.norm_then, vMark: row.v_mark }));
}
