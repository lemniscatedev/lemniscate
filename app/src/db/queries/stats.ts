import { fixed, decimal } from "../../lib/fixed";
import { apiNow } from "../../api/clock";
import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows, numberValue, textValue } from "../../api/types";
import { listMarkets } from "./markets";

export async function aggregateStats(deps: ApiDependencies) {
  const now = await apiNow(deps);
  const nowIso = now.toISOString();
  const [markets, vaultResult, tradeResult, totalsResult] = await Promise.all([
    listMarkets(deps, now),
    deps.sql`select total_assets::text from vault_ticks order by ts desc limit 1`,
    deps.sql`select count(*)::int as trades_24h from trades where ts >= ${nowIso}::timestamptz - interval '24 hours'`,
    deps.sql`
      select coalesce(sum(fee) filter (where ts >= ${nowIso}::timestamptz - interval '24 hours'), 0)::text as fees_24h,
        (count(distinct account) filter (where ts >= ${nowIso}::timestamptz - interval '24 hours'))::int as traders_24h,
        coalesce(sum(usdg), 0)::text as volume_all,
        count(*)::int as trades_all,
        count(distinct account)::int as traders_all
      from trades where ts <= ${nowIso}::timestamptz
    `,
  ]);
  const openInterest = markets.reduce((total, market) => total + fixed(market.openInterestUsd), 0n);
  const volume = markets.reduce((total, market) => total + fixed(market.volume24hUsd), 0n);
  const vault = asRows<DbRow>(vaultResult)[0];
  const trade = asRows<DbRow>(tradeResult)[0];
  const totals = asRows<DbRow>(totalsResult)[0];
  return {
    openInterestUsd: decimal(openInterest),
    volume24hUsd: decimal(volume),
    trades24h: numberValue(trade?.trades_24h),
    tvlUsd: String(vault?.total_assets ?? "0"),
    fees24hUsd: textValue(totals?.fees_24h, "0"),
    uniqueTraders24h: numberValue(totals?.traders_24h),
    volumeAllTimeUsd: textValue(totals?.volume_all, "0"),
    tradesAllTime: numberValue(totals?.trades_all),
    tradersAllTime: numberValue(totals?.traders_all),
    markets: markets.filter((market) => market.launched).map((market) => ({
      symbol: market.symbol,
      price: market.price,
      dailyCarryPct: market.dailyCarryPct,
      regime: market.regime,
    })),
  };
}
