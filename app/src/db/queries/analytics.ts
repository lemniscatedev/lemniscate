import { fixed, ratioPercent } from "../../lib/fixed";
import { apiNow } from "../../api/clock";
import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows, numberValue, textValue } from "../../api/types";

export type HistoryRange = "7D" | "30D" | "90D" | "ALL";

const LOOKBACK_DAYS: Record<Exclude<HistoryRange, "ALL">, number> = { "7D": 7, "30D": 30, "90D": 90 };
const DAY_SECONDS = 86_400;

export interface ProtocolHistoryPoint {
  t: number;
  volumeUsd: string;
  buyVolumeUsd: string;
  sellVolumeUsd: string;
  feesUsd: string;
  trades: number;
  uniqueTraders: number;
  tvlUsd: string | null;
}

export interface MarketShare {
  symbol: string;
  volumeUsd: string;
  trades: number;
  sharePct: number;
}

function floorDay(seconds: number): number {
  return Math.floor(seconds / DAY_SECONDS) * DAY_SECONDS;
}

export function buildDailySeries(
  startSec: number,
  endSec: number,
  tradeRows: DbRow[],
  tvlRows: DbRow[],
  seedTvl: string | null,
): ProtocolHistoryPoint[] {
  const tradesByDay = new Map(tradeRows.map((row) => [numberValue(row.t), row]));
  const tvlByDay = new Map(tvlRows.map((row) => [numberValue(row.t), row]));
  const points: ProtocolHistoryPoint[] = [];
  let tvl = seedTvl;
  for (let t = startSec; t <= floorDay(endSec); t += DAY_SECONDS) {
    const trade = tradesByDay.get(t);
    const tvlRow = tvlByDay.get(t);
    if (tvlRow && tvlRow.tvl !== null && tvlRow.tvl !== undefined) tvl = textValue(tvlRow.tvl);
    points.push({
      t,
      volumeUsd: textValue(trade?.volume, "0"),
      buyVolumeUsd: textValue(trade?.buy_volume, "0"),
      sellVolumeUsd: textValue(trade?.sell_volume, "0"),
      feesUsd: textValue(trade?.fees, "0"),
      trades: numberValue(trade?.trades),
      uniqueTraders: numberValue(trade?.traders),
      tvlUsd: tvl,
    });
  }
  return points;
}

export function marketShares(rows: DbRow[]): MarketShare[] {
  const total = rows.reduce((sum, row) => sum + fixed(textValue(row.volume, "0")), 0n);
  return rows.map((row) => ({
    symbol: textValue(row.symbol),
    volumeUsd: textValue(row.volume, "0"),
    trades: numberValue(row.trades),
    sharePct: total > 0n ? ratioPercent(fixed(textValue(row.volume, "0")), total) : 0,
  }));
}

function emptySummary() {
  return { volumeUsd: "0", buyVolumeUsd: "0", sellVolumeUsd: "0", feesUsd: "0", trades: 0, uniqueTraders: 0 };
}

export async function protocolHistory(deps: ApiDependencies, range: HistoryRange, requestedNow?: Date) {
  const now = requestedNow ?? await apiNow(deps);
  const nowSec = Math.floor(now.getTime() / 1000);
  let startSec: number;
  if (range === "ALL") {
    const firstResult = await deps.sql`
      select floor(extract(epoch from least((select min(ts) from trades), (select min(ts) from vault_ticks))))::bigint as first
    `;
    const first = asRows<DbRow>(firstResult)[0]?.first;
    if (first === null || first === undefined) {
      const iso = now.toISOString();
      return { range, from: iso, to: iso, summary: emptySummary(), points: [], markets: [] };
    }
    startSec = floorDay(numberValue(first));
  } else {
    startSec = floorDay(nowSec - LOOKBACK_DAYS[range] * DAY_SECONDS);
  }

  const start = new Date(startSec * 1000).toISOString();
  const end = now.toISOString();
  const [dailyResult, summaryResult, marketResult, tvlResult, seedResult] = await Promise.all([
    deps.sql`
      select floor(extract(epoch from time_bucket(interval '1 day', ts)))::bigint as t,
        sum(usdg)::text as volume,
        sum(case when side = 'buy' then usdg else 0 end)::text as buy_volume,
        sum(case when side = 'sell' then usdg else 0 end)::text as sell_volume,
        sum(fee)::text as fees,
        count(*)::int as trades,
        count(distinct account)::int as traders
      from trades where ts >= ${start}::timestamptz and ts <= ${end}::timestamptz
      group by 1 order by 1
    `,
    deps.sql`
      select coalesce(sum(usdg), 0)::text as volume,
        coalesce(sum(case when side = 'buy' then usdg else 0 end), 0)::text as buy_volume,
        coalesce(sum(case when side = 'sell' then usdg else 0 end), 0)::text as sell_volume,
        coalesce(sum(fee), 0)::text as fees,
        count(*)::int as trades,
        count(distinct account)::int as traders
      from trades where ts >= ${start}::timestamptz and ts <= ${end}::timestamptz
    `,
    deps.sql`
      select m.symbol, sum(t.usdg)::text as volume, count(*)::int as trades
      from trades t join markets m on m.id = t.market_id
      where t.ts >= ${start}::timestamptz and t.ts <= ${end}::timestamptz
      group by m.symbol order by sum(t.usdg) desc, m.symbol
    `,
    deps.sql`
      select floor(extract(epoch from time_bucket(interval '1 day', ts)))::bigint as t,
        last(total_assets, ts)::text as tvl
      from vault_ticks where ts >= ${start}::timestamptz and ts <= ${end}::timestamptz
      group by 1 order by 1
    `,
    deps.sql`select total_assets::text as tvl from vault_ticks where ts < ${start}::timestamptz order by ts desc limit 1`,
  ]);

  const seed = asRows<DbRow>(seedResult)[0]?.tvl;
  const summary = asRows<DbRow>(summaryResult)[0];
  return {
    range,
    from: start,
    to: end,
    summary: {
      volumeUsd: textValue(summary?.volume, "0"),
      buyVolumeUsd: textValue(summary?.buy_volume, "0"),
      sellVolumeUsd: textValue(summary?.sell_volume, "0"),
      feesUsd: textValue(summary?.fees, "0"),
      trades: numberValue(summary?.trades),
      uniqueTraders: numberValue(summary?.traders),
    },
    points: buildDailySeries(startSec, nowSec, asRows<DbRow>(dailyResult), asRows<DbRow>(tvlResult), seed === null || seed === undefined ? null : textValue(seed)),
    // Keep market shares based on total indexed volume; the public route applies
    // current launch visibility after its long-lived history cache.
    markets: marketShares(asRows<DbRow>(marketResult)),
  };
}
