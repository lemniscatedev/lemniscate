import { decimal, ratioPercent } from "../../lib/fixed";
import { powerLedgerEvents, replayPowerLedger, type RealizedFill } from "./power-ledger";
import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows, dateValue, numberValue, textValue } from "../../api/types";

export interface CloseSummary {
  symbol: string;
  realizedPnlUsd: string;
  ts: string;
  txHash: string;
}

export interface FillSummary {
  realizedPnlUsd: string;
  closedTrades: number;
  winningTrades: number;
  winRatePct: number | null;
  bestTrade: CloseSummary | null;
  worstTrade: CloseSummary | null;
  byMarket: Map<string, bigint>;
}

/** Realized P&L, win rate and extreme closes over a wallet's sells. Ties keep the earliest fill. */
export function summarizeFills(fills: RealizedFill[], symbolById: Map<number, string>): FillSummary {
  const symbolOf = (fill: RealizedFill) => symbolById.get(fill.marketId) ?? String(fill.marketId);
  const close = (fill: RealizedFill | null): CloseSummary | null => fill
    ? { symbol: symbolOf(fill), realizedPnlUsd: decimal(fill.realized), ts: fill.ts, txHash: fill.txHash }
    : null;
  let total = 0n;
  let wins = 0;
  let best: RealizedFill | null = null;
  let worst: RealizedFill | null = null;
  const byMarket = new Map<string, bigint>();
  for (const fill of fills) {
    total += fill.realized;
    if (fill.realized > 0n) wins += 1;
    if (!best || fill.realized > best.realized) best = fill;
    if (!worst || fill.realized < worst.realized) worst = fill;
    const symbol = symbolOf(fill);
    byMarket.set(symbol, (byMarket.get(symbol) ?? 0n) + fill.realized);
  }
  const closed = fills.length;
  return {
    realizedPnlUsd: decimal(total),
    closedTrades: closed,
    winningTrades: wins,
    winRatePct: closed > 0 ? ratioPercent(BigInt(wins), BigInt(closed)) : null,
    bestTrade: close(best),
    worstTrade: close(worst),
    byMarket,
  };
}

/** Lifetime trading statistics for one wallet, from its executed trades and power-token ledger. */
export async function accountStats(deps: ApiDependencies, address: string) {
  const [totalsResult, marketsResult, symbolsResult, ledger] = await Promise.all([
    deps.sql`
      select count(*)::int as trades,
        count(*) filter (where side = 'buy')::int as buys,
        count(*) filter (where side = 'sell')::int as sells,
        coalesce(sum(usdg), 0)::text as volume,
        coalesce(sum(fee), 0)::text as fees,
        min(ts) as first_at, max(ts) as last_at,
        count(distinct market_id)::int as markets,
        count(distinct (ts at time zone 'UTC')::date)::int as active_days
      from trades where account = ${address}
    `,
    deps.sql`
      select m.symbol, sum(t.usdg)::text as volume, count(*)::int as trades
      from trades t join markets m on m.id = t.market_id where t.account = ${address}
      group by m.symbol order by sum(t.usdg) desc
    `,
    deps.sql`select id, symbol from markets order by id`,
    powerLedgerEvents(deps, address),
  ]);
  const totals = asRows<DbRow>(totalsResult)[0] ?? {};
  const symbolById = new Map(asRows<DbRow>(symbolsResult).map((row) => [numberValue(row.id), textValue(row.symbol)]));
  const { fills } = replayPowerLedger(ledger.events, address);
  const summary = summarizeFills(fills, symbolById);
  const markets = asRows<DbRow>(marketsResult).map((row) => {
    const symbol = textValue(row.symbol);
    return { symbol, volumeUsd: textValue(row.volume, "0"), trades: numberValue(row.trades), realizedPnlUsd: decimal(summary.byMarket.get(symbol) ?? 0n) };
  });
  // Markets closed from received tokens only have fills but no executed trades.
  for (const [symbol, realized] of summary.byMarket) {
    if (!markets.some((market) => market.symbol === symbol)) markets.push({ symbol, volumeUsd: "0", trades: 0, realizedPnlUsd: decimal(realized) });
  }
  return {
    volumeUsd: textValue(totals.volume, "0"),
    feesPaidUsd: textValue(totals.fees, "0"),
    trades: numberValue(totals.trades),
    buys: numberValue(totals.buys),
    sells: numberValue(totals.sells),
    marketsTraded: numberValue(totals.markets),
    activeDays: numberValue(totals.active_days),
    firstTradeAt: dateValue(totals.first_at)?.toISOString() ?? null,
    lastTradeAt: dateValue(totals.last_at)?.toISOString() ?? null,
    realizedPnlUsd: summary.realizedPnlUsd,
    closedTrades: summary.closedTrades,
    winningTrades: summary.winningTrades,
    winRatePct: summary.winRatePct,
    bestTrade: summary.bestTrade,
    worstTrade: summary.worstTrade,
    markets,
    historyComplete: ledger.historyComplete,
  };
}
