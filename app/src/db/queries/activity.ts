import type { QueryDeps } from "./series";

export type ActivityKind =
  | "buy" | "sell" | "shield" | "sell_queued" | "sell_filled" | "sell_cancelled"
  | "pool_deposit" | "pool_withdraw" | "withdraw_requested" | "withdraw_claimed" | "agent_buy" | "agent_sell";

export interface ActivityRow {
  kind: ActivityKind;
  ts: string;
  block: string;
  txHash: string;
  logIndex: number;
  seriesId: string | null;
  name: string | null;
  isCall: boolean | null;
  speed: "DAILY" | "WEEKLY" | null;
  strike: string | null;
  /** USDG paid or received; null where the event has no cash leg (a queued sell, a withdrawal request). */
  usdg: string | null;
  /** Option units (trades), option tokens (queued sells), Stock Token units (shields) or pool shares. */
  amount: string | null;
  ticket: string | null;
  agent: string | null;
  filler: string | null;
  /** Queued sells only: where the ticket stands now. */
  status: "open" | "filled" | "cancelled" | null;
}

export interface ActivityCursor { ts: string; txHash: string; logIndex: number; kind: string }

export const encodeCursor = (cursor: ActivityCursor): string => Buffer.from(JSON.stringify(cursor)).toString("base64url");

export function decodeCursor(value: string): ActivityCursor | null {
  try {
    const parsed = JSON.parse(Buffer.from(value, "base64url").toString("utf8")) as Partial<ActivityCursor>;
    if (typeof parsed.ts !== "string" || Number.isNaN(Date.parse(parsed.ts))) return null;
    if (typeof parsed.txHash !== "string" || typeof parsed.kind !== "string") return null;
    if (!Number.isInteger(parsed.logIndex)) return null;
    return { ts: new Date(parsed.ts).toISOString(), txHash: parsed.txHash, logIndex: parsed.logIndex as number, kind: parsed.kind };
  } catch {
    return null;
  }
}

interface ActivityDbRow {
  kind: ActivityKind; ts: Date | string; block: string; tx_hash: string; log_index: number; series_id: string | null;
  name: string | null; is_call: boolean | null; speed: "DAILY" | "WEEKLY" | null; strike: string | null; usdg: string | null;
  amount: string | null; ticket: string | null; agent: string | null; filler: string | null; status: "open" | "filled" | "cancelled" | null;
}

/**
 * One account's history, newest first, from indexed tables only. Keyset pagination on (ts, tx_hash, log_index, kind).
 * A trade made by the account's agent shows once, as agent_buy / agent_sell, not also as buy / sell.
 */
export async function accountActivity(
  deps: QueryDeps,
  account: string,
  options: { limit: number; cursor?: ActivityCursor | null },
): Promise<{ items: ActivityRow[]; next: ActivityCursor | null }> {
  const who = account.toLowerCase();
  const limit = Math.min(Math.max(options.limit, 1), 200);
  const cursor = options.cursor ?? null;
  const rows = (await deps.sql`
    WITH feed AS (
      SELECT t.side AS kind, t.ts, t.block::text AS block, t.tx_hash, t.log_index, t.series_id, t.usdg, t.units AS amount,
             NULL::text AS ticket, NULL::text AS agent, NULL::text AS filler, NULL::text AS status
      FROM trades t
      WHERE (t.account = ${who} OR t.recipient = ${who})
        AND NOT EXISTS (SELECT 1 FROM agent_trades a WHERE a.tx_hash = t.tx_hash AND a.owner = ${who})
      UNION ALL
      SELECT 'shield', s.ts, s.block::text, s.tx_hash, s.log_index, s.series_id, s.usdg_paid, s.token_units, NULL, NULL, NULL, NULL
      FROM shields s WHERE s.account = ${who}
      UNION ALL
      SELECT 'sell_queued', q.queued_at, q.queued_block::text, q.queued_tx, q.queued_log, q.series_id, NULL, q.tokens, q.ticket::text, NULL, NULL, q.status
      FROM queued_sells q WHERE q.seller = ${who}
      UNION ALL
      SELECT 'sell_queued', q.queued_at, q.queued_block::text, q.queued_tx, q.queued_log, q.series_id, NULL, q.tokens, q.ticket::text, r.agent, NULL, q.status
      FROM queued_sells q JOIN router_tickets r ON r.ticket = q.ticket WHERE r.owner = ${who}
      UNION ALL
      SELECT CASE q.status WHEN 'filled' THEN 'sell_filled' ELSE 'sell_cancelled' END, q.closed_at, q.closed_block::text, q.closed_tx, q.closed_log,
             q.series_id, q.usdg_out, q.tokens, q.ticket::text, NULL, q.filler, q.status
      FROM queued_sells q WHERE q.seller = ${who} AND q.status IN ('filled', 'cancelled') AND q.closed_tx IS NOT NULL
      UNION ALL
      SELECT CASE q.status WHEN 'filled' THEN 'sell_filled' ELSE 'sell_cancelled' END, q.closed_at, q.closed_block::text, q.closed_tx, q.closed_log,
             q.series_id, q.usdg_out, q.tokens, q.ticket::text, r.agent, q.filler, q.status
      FROM queued_sells q JOIN router_tickets r ON r.ticket = q.ticket
      WHERE r.owner = ${who} AND q.status IN ('filled', 'cancelled') AND q.closed_tx IS NOT NULL
      UNION ALL
      SELECT 'pool_' || p.kind, p.ts, p.block::text, p.tx_hash, p.log_index, NULL, p.assets, p.shares, NULL, NULL, NULL, NULL
      FROM pool_events p WHERE p.account = ${who}
      UNION ALL
      SELECT 'withdraw_requested', w.queued_at, w.queued_block::text, w.queued_tx, w.queued_log, NULL, NULL, w.shares, w.ticket::text, NULL, NULL, NULL
      FROM withdrawals w WHERE w.owner = ${who}
      UNION ALL
      SELECT 'withdraw_claimed', w.claimed_at, w.claimed_block::text, w.claimed_tx, w.claimed_log, NULL, w.usdg, w.shares, w.ticket::text, NULL, NULL, NULL
      FROM withdrawals w WHERE w.owner = ${who} AND w.status = 'claimed' AND w.claimed_tx IS NOT NULL
      UNION ALL
      SELECT CASE WHEN g.is_buy THEN 'agent_buy' ELSE 'agent_sell' END, g.ts, g.block::text, g.tx_hash, g.log_index, g.series_id, g.usdg, NULL, NULL, g.agent, NULL, NULL
      FROM agent_trades g WHERE g.owner = ${who}
    )
    SELECT f.kind, f.ts, f.block, f.tx_hash, f.log_index, f.series_id, s.name, s.is_call, s.speed, s.strike::text AS strike,
           f.usdg::text AS usdg, f.amount::text AS amount, f.ticket, f.agent, f.filler, f.status
    FROM feed f LEFT JOIN series s ON s.id = f.series_id
    WHERE ${cursor === null ? deps.sql`TRUE` : deps.sql`(f.ts, f.tx_hash, f.log_index, f.kind) < (${cursor.ts}::timestamptz, ${cursor.txHash}, ${cursor.logIndex}::int, ${cursor.kind})`}
    ORDER BY f.ts DESC, f.tx_hash DESC, f.log_index DESC, f.kind DESC
    LIMIT ${limit + 1}
  `) as unknown as ActivityDbRow[];
  const page = rows.slice(0, limit);
  const items = page.map((row): ActivityRow => ({
    kind: row.kind, ts: new Date(row.ts).toISOString(), block: String(row.block), txHash: row.tx_hash, logIndex: row.log_index,
    seriesId: row.series_id, name: row.name, isCall: row.is_call, speed: row.speed, strike: row.strike, usdg: row.usdg,
    amount: row.amount, ticket: row.ticket, agent: row.agent, filler: row.filler, status: row.status,
  }));
  const last = items[items.length - 1];
  const next = rows.length > limit && last ? { ts: last.ts, txHash: last.txHash, logIndex: last.logIndex, kind: last.kind } : null;
  return { items, next };
}

export interface AgentPolicyRow {
  agent: string;
  budgetUsdg: string;
  maxPerTradeUsdg: string;
  expiresAt: string;
  canSell: boolean;
  canShield: boolean;
  /** The names the policy allows (newest PolicyStocks), with the series name where the indexer knows the stock. */
  allowedStocks: { stock: string; name: string | null }[];
  setAt: string;
  revoked: boolean;
  revokedAt: string | null;
}

export interface AgentTradeRow {
  txHash: string;
  logIndex: number;
  ts: string;
  agent: string;
  seriesId: string;
  name: string | null;
  isCall: boolean | null;
  speed: "DAILY" | "WEEKLY" | null;
  strike: string | null;
  side: "buy" | "sell";
  usdg: string;
}

/** The newest PolicySet of every agent the owner ever set, with whether a later PolicyRevoked closed it. */
export async function ownerAgentPolicies(deps: QueryDeps, owner: string): Promise<AgentPolicyRow[]> {
  const rows = (await deps.sql`
    WITH latest_set AS (
      SELECT DISTINCT ON (agent) agent, ts, block, log_index, budget_usdg, max_per_trade_usdg, expires_at, can_sell, can_shield
      FROM agent_policy_events WHERE owner = ${owner.toLowerCase()} AND kind = 'set' ORDER BY agent, block DESC, log_index DESC
    ), latest_revoke AS (
      SELECT DISTINCT ON (agent) agent, ts, block, log_index
      FROM agent_policy_events WHERE owner = ${owner.toLowerCase()} AND kind = 'revoked' ORDER BY agent, block DESC, log_index DESC
    )
    SELECT s.agent, s.ts, s.budget_usdg::text AS budget_usdg, s.max_per_trade_usdg::text AS max_per_trade_usdg, s.expires_at,
           s.can_sell, s.can_shield,
           COALESCE((SELECT st.stocks FROM agent_policy_stocks st WHERE st.owner = ${owner.toLowerCase()} AND st.agent = s.agent
                     ORDER BY st.block DESC, st.log_index DESC LIMIT 1), ARRAY[]::text[]) AS stocks,
           (r.agent IS NOT NULL AND (r.block, r.log_index) > (s.block, s.log_index)) AS revoked,
           CASE WHEN r.agent IS NOT NULL AND (r.block, r.log_index) > (s.block, s.log_index) THEN r.ts END AS revoked_at
    FROM latest_set s LEFT JOIN latest_revoke r ON r.agent = s.agent
    ORDER BY s.ts DESC, s.agent
  `) as unknown as {
    agent: string; ts: Date | string; budget_usdg: string; max_per_trade_usdg: string; expires_at: Date | string;
    can_sell: boolean; can_shield: boolean; stocks: string[]; revoked: boolean; revoked_at: Date | string | null;
  }[];
  const wanted = [...new Set(rows.flatMap((row) => row.stocks))];
  const names = new Map<string, string>();
  if (wanted.length > 0) {
    const named = (await deps.sql`
      SELECT DISTINCT ON (stock_token) stock_token, name FROM series WHERE stock_token IN ${deps.sql(wanted)} AND name IS NOT NULL ORDER BY stock_token, name
    `) as unknown as { stock_token: string; name: string }[];
    for (const row of named) names.set(row.stock_token, row.name);
  }
  return rows.map((row) => ({
    allowedStocks: row.stocks.map((stock) => ({ stock, name: names.get(stock) ?? null })),
    agent: row.agent, budgetUsdg: row.budget_usdg, maxPerTradeUsdg: row.max_per_trade_usdg,
    expiresAt: new Date(row.expires_at).toISOString(), canSell: row.can_sell, canShield: row.can_shield,
    setAt: new Date(row.ts).toISOString(), revoked: row.revoked, revokedAt: row.revoked_at ? new Date(row.revoked_at).toISOString() : null,
  }));
}

/** Per agent: buys counted against the budget, trade count, and the newest trades (at most `perAgent` each). */
export async function ownerAgentTrades(
  deps: QueryDeps,
  owner: string,
  perAgent = 10,
): Promise<{ totals: Map<string, { spentUsdg: string; trades: number }>; recent: Map<string, AgentTradeRow[]> }> {
  const who = owner.toLowerCase();
  const totalRows = (await deps.sql`
    SELECT agent, COALESCE(SUM(usdg) FILTER (WHERE is_buy), 0)::text AS spent, COUNT(*)::int AS trades
    FROM agent_trades WHERE owner = ${who} GROUP BY agent
  `) as unknown as { agent: string; spent: string; trades: number }[];
  const recentRows = (await deps.sql`
    SELECT * FROM (
      SELECT g.tx_hash, g.log_index, g.ts, g.agent, g.series_id, s.name, s.is_call, s.speed, s.strike::text AS strike, g.is_buy, g.usdg::text AS usdg,
             row_number() OVER (PARTITION BY g.agent ORDER BY g.ts DESC, g.log_index DESC) AS rank
      FROM agent_trades g LEFT JOIN series s ON s.id = g.series_id WHERE g.owner = ${who}
    ) ranked WHERE rank <= ${perAgent} ORDER BY ts DESC, log_index DESC
  `) as unknown as {
    tx_hash: string; log_index: number; ts: Date | string; agent: string; series_id: string; name: string | null; is_call: boolean | null;
    speed: "DAILY" | "WEEKLY" | null; strike: string | null; is_buy: boolean; usdg: string;
  }[];
  const totals = new Map(totalRows.map((row) => [row.agent, { spentUsdg: row.spent, trades: row.trades }]));
  const recent = new Map<string, AgentTradeRow[]>();
  for (const row of recentRows) {
    const list = recent.get(row.agent) ?? [];
    list.push({
      txHash: row.tx_hash, logIndex: row.log_index, ts: new Date(row.ts).toISOString(), agent: row.agent, seriesId: row.series_id,
      name: row.name, isCall: row.is_call, speed: row.speed, strike: row.strike, side: row.is_buy ? "buy" : "sell", usdg: row.usdg,
    });
    recent.set(row.agent, list);
  }
  return { totals, recent };
}

/** True when the address has been seen on chain by the indexer (a Kernel account can only act once deployed). */
export async function accountSeenOnChain(deps: QueryDeps, address: string): Promise<boolean> {
  const rows = await deps.sql`SELECT 1 FROM account_metadata WHERE address = ${address.toLowerCase()} LIMIT 1`;
  return rows.length > 0;
}
