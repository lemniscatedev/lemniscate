import type { QueryDeps } from "./series";

export interface PositionRow {
  seriesId: string;
  name: string | null;
  isCall: boolean;
  speed: "DAILY" | "WEEKLY";
  strike: string;
  token: string;
  /** Option-token balance (18 dp). */
  balance: string;
  norm: string;
  /** balance x norm: what the holder is long. */
  units: string;
  buyable: boolean;
  archived: boolean;
  /** Last indexed accrual (ISO), for projecting the norm to now. */
  lastAccrual: string;
  /** Totals from the trade history, USDG. */
  boughtUsdg: string;
  soldUsdg: string;
}

/** Open positions of an account: every series whose token it holds, with units after funding and its trade totals. */
export async function accountPositions(deps: QueryDeps, account: string): Promise<PositionRow[]> {
  const rows = (await deps.sql`
    SELECT s.id AS series_id, s.name, s.is_call, s.speed, s.strike, s.token, b.balance, s.norm,
           (b.balance * s.norm)::numeric(78, 18) AS units, s.buyable, s.archived,
           extract(epoch from s.last_accrual)::float8 AS last_accrual_s,
           COALESCE((SELECT SUM(usdg) FROM trades t WHERE t.series_id = s.id AND t.recipient = ${account.toLowerCase()} AND t.side = 'buy'), 0) AS bought_usdg,
           COALESCE((SELECT SUM(usdg) FROM trades t WHERE t.series_id = s.id AND t.account = ${account.toLowerCase()} AND t.side = 'sell'), 0) AS sold_usdg
    FROM balances b
    JOIN series s ON s.token = b.token
    WHERE b.account = ${account.toLowerCase()} AND b.balance > 0
    ORDER BY s.name, s.speed, s.strike, s.is_call DESC
  `) as unknown as {
    series_id: string; name: string | null; is_call: boolean; speed: "DAILY" | "WEEKLY"; strike: string; token: string;
    balance: string; norm: string; units: string; buyable: boolean; archived: boolean; last_accrual_s: number; bought_usdg: string; sold_usdg: string;
  }[];
  return rows.map((row) => ({
    seriesId: row.series_id,
    name: row.name,
    isCall: row.is_call,
    speed: row.speed,
    strike: row.strike,
    token: row.token,
    balance: row.balance,
    norm: row.norm,
    units: row.units,
    buyable: row.buyable,
    archived: row.archived,
    lastAccrual: new Date(Number(row.last_accrual_s) * 1000).toISOString(),
    boughtUsdg: row.bought_usdg,
    soldUsdg: row.sold_usdg,
  }));
}

export interface TradeRow {
  txHash: string;
  logIndex: number;
  ts: string;
  seriesId: string;
  account: string;
  recipient: string;
  side: "buy" | "sell";
  units: string;
  shares: string;
  usdg: string;
  vMark: string;
  sigmaBps: number;
  session: string;
}

interface TradeDbRow {
  tx_hash: string; log_index: number; ts: Date | string; series_id: string; account: string; recipient: string;
  side: "buy" | "sell"; units: string; shares: string; usdg: string; v_mark: string; sigma_bps: number; session: string;
}

const toTrade = (row: TradeDbRow): TradeRow => ({
  txHash: row.tx_hash, logIndex: row.log_index, ts: new Date(row.ts).toISOString(), seriesId: row.series_id,
  account: row.account, recipient: row.recipient, side: row.side, units: row.units, shares: row.shares, usdg: row.usdg,
  vMark: row.v_mark, sigmaBps: row.sigma_bps, session: row.session,
});

/** Newest first. Pass an account (as trader or recipient) or a series. */
export async function recentTrades(
  deps: QueryDeps,
  filter: { account?: string; seriesId?: string; limit?: number },
): Promise<TradeRow[]> {
  const account = filter.account?.toLowerCase() ?? null;
  const seriesId = filter.seriesId?.toLowerCase() ?? null;
  const rows = (await deps.sql`
    SELECT tx_hash, log_index, ts, series_id, account, recipient, side, units, shares, usdg, v_mark, sigma_bps, session
    FROM trades
    WHERE (${account}::text IS NULL OR account = ${account} OR recipient = ${account})
      AND (${seriesId}::text IS NULL OR series_id = ${seriesId})
    ORDER BY ts DESC, log_index DESC
    LIMIT ${Math.min(Math.max(filter.limit ?? 100, 1), 1_000)}
  `) as unknown as TradeDbRow[];
  return rows.map(toTrade);
}
