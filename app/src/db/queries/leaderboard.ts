import { fixed } from "../../lib/fixed";
import { apiNow } from "../../api/clock";
import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows, dateValue, numberValue, textValue } from "../../api/types";

export type BoardRange = "7D" | "30D" | "ALL";
export type BoardSort = "volume" | "trades";

const LOOKBACK: Record<Exclude<BoardRange, "ALL">, string> = { "7D": "7 days", "30D": "30 days" };

export interface LeaderboardRow {
  rank: number;
  address: string;
  volumeUsd: string;
  trades: number;
  markets: number;
  topMarket: string | null;
  lastTradeAt: string;
}

function compareVolume(a: DbRow, b: DbRow): number {
  const left = fixed(textValue(a.volume, "0"));
  const right = fixed(textValue(b.volume, "0"));
  return right > left ? 1 : right < left ? -1 : 0;
}

export function rankRows(rows: DbRow[], sort: BoardSort): LeaderboardRow[] {
  return [...rows]
    .sort((a, b) => {
      const primary = sort === "trades"
        ? numberValue(b.trades) - numberValue(a.trades) || compareVolume(a, b)
        : compareVolume(a, b);
      return primary || textValue(a.account).localeCompare(textValue(b.account));
    })
    .map((row, index) => ({
      rank: index + 1,
      address: textValue(row.account).toLowerCase(),
      volumeUsd: textValue(row.volume, "0"),
      trades: numberValue(row.trades),
      markets: numberValue(row.markets),
      topMarket: row.top_market === null || row.top_market === undefined ? null : textValue(row.top_market),
      lastTradeAt: dateValue(row.last_trade_at)?.toISOString() ?? "1970-01-01T00:00:00.000Z",
    }));
}

export async function traderRanking(
  deps: ApiDependencies,
  range: BoardRange,
  sort: BoardSort,
  requestedNow?: Date,
): Promise<LeaderboardRow[]> {
  const now = requestedNow ?? await apiNow(deps);
  const lower = range === "ALL" ? "" : `and t.ts >= $1::timestamptz - interval '${LOOKBACK[range]}'`;
  const rows = await deps.sql.unsafe(`
    select t.account, sum(t.usdg)::text as volume, count(*)::int as trades,
      count(distinct t.market_id)::int as markets, max(t.ts) as last_trade_at,
      mode() within group (order by m.symbol) as top_market
    from trades t join markets m on m.id = t.market_id
    where t.ts <= $1::timestamptz ${lower}
    group by t.account
  `, [now.toISOString()]);
  return rankRows(asRows<DbRow>(rows), sort);
}
