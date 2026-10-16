import { fixed, decimal, multiply, ratioPercent, fromBps, roundedPercent } from "../../lib/fixed";
import { apiNow } from "../../api/clock";
import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows, dateValue, numberValue, textValue } from "../../api/types";
import { isLaunched } from "../../config/launch";

export async function vaultSnapshot(deps: ApiDependencies) {
  const now = await apiNow(deps);
  const [vaultResult, marketResult, changeResult, change30dResult, inceptionResult] = await Promise.all([
    deps.sql`select * from vault_ticks order by ts desc limit 1`,
    deps.sql`
      select m.symbol, ml.launched, t.liability::text, t.hedge_units::text, t.hedge_target::text, t.spot::text
      from markets m
      left join market_launch ml on upper(ml.symbol) = upper(m.symbol)
      left join lateral (select * from ticks where market_id = m.id order by ts desc limit 1) t on true
      order by m.id
    `,
    deps.sql`
      select nav_per_share::text from vault_ticks
      where ts <= ${now.toISOString()}::timestamptz - interval '7 days' order by ts desc limit 1
    `,
    deps.sql`
      select nav_per_share::text from vault_ticks
      where ts <= ${now.toISOString()}::timestamptz - interval '30 days' order by ts desc limit 1
    `,
    deps.sql`select nav_per_share::text from vault_ticks order by ts asc limit 1`,
  ]);
  const vault = asRows<DbRow>(vaultResult)[0] ?? {};
  const nav = fixed(vault.nav as string | undefined);
  const navPerShare = fixed(vault.nav_per_share as string | undefined);
  const totalLiability = fixed(vault.total_liability as string | undefined);
  const totalSupply = fixed(vault.total_supply as string | undefined);
  const usdg = fixed(vault.usdg as string | undefined);
  const maxGlobalExposureBps = numberValue(vault.max_global_exposure_bps, 5000);
  const exposureLimit = nav > 0n ? fromBps(nav, maxGlobalExposureBps) : 0n;
  const priorNavPerShare = fixed(asRows<DbRow>(changeResult)[0]?.nav_per_share as string | undefined);
  const referenceChange = (result: unknown): number | null => {
    const reference = fixed(asRows<DbRow>(result)[0]?.nav_per_share as string | undefined);
    return reference > 0n ? ratioPercent(navPerShare - reference, reference) : null;
  };
  const markets = asRows<DbRow>(marketResult).filter((row) =>
    isLaunched(textValue(row.symbol), typeof row.launched === "boolean" ? row.launched : undefined)).map((row) => {
    const liability = fixed(row.liability as string | undefined);
    const hedgeUnits = fixed(row.hedge_units as string | undefined);
    const hedgeTarget = fixed(row.hedge_target as string | undefined);
    const spot = fixed(row.spot as string | undefined);
    return {
      symbol: textValue(row.symbol),
      liability: decimal(liability),
      hedgeUnits: decimal(hedgeUnits),
      hedgeTarget: decimal(hedgeTarget),
      hedgeValue: decimal(multiply(hedgeUnits, spot)),
      deltaPct: ratioPercent(hedgeUnits - hedgeTarget, hedgeTarget),
    };
  });
  return {
    nav: decimal(nav),
    navPerShare: decimal(navPerShare),
    totalSupply: decimal(totalSupply),
    usdg: decimal(usdg),
    totalLiability: decimal(totalLiability),
    utilizationPct: ratioPercent(totalLiability, exposureLimit),
    maxGlobalExposurePct: roundedPercent(maxGlobalExposureBps / 100),
    publicDeposits: vault.public_deposits === true,
    markets,
    change7dPct: priorNavPerShare > 0n ? ratioPercent(navPerShare - priorNavPerShare, priorNavPerShare) : 0,
    change30dPct: referenceChange(change30dResult),
    changeSinceInceptionPct: referenceChange(inceptionResult),
    depositCapRemaining: decimal(fixed(vault.deposit_cap_remaining as string | undefined)),
  };
}

export async function vaultHistory(
  deps: ApiDependencies,
  range: "1W" | "1M" | "ALL",
  requestedNow?: Date,
): Promise<Array<{ t: number; navPerShare: string; nav: string }>> {
  const now = requestedNow ?? await apiNow(deps);
  const nowIso = now.toISOString();
  const rangeClause = range === "1W"
    ? "where bucket >= $1::timestamptz - interval '7 days'"
    : range === "1M" ? "where bucket >= $1::timestamptz - interval '30 days'" : "";
  const aggregateRows = await deps.sql.unsafe(
    `select floor(extract(epoch from bucket))::bigint as t, close_nav_per_share::text as nav_per_share,
      close_nav::text as nav from vault_1h ${rangeClause} order by bucket`,
    rangeClause ? [nowIso] : [],
  );
  // The continuous aggregate intentionally trails by two hours. Overlay recent
  // raw ticks so a new deployment appears in history before materialization.
  const rawRows = await deps.sql.unsafe(
    `select floor(extract(epoch from time_bucket(interval '1 hour', ts)))::bigint as t,
      last(nav_per_share, ts)::text as nav_per_share, last(nav, ts)::text as nav
     from vault_ticks where ts >= $1::timestamptz - interval '3 days'
     group by time_bucket(interval '1 hour', ts) order by 1`,
    [nowIso],
  );
  const pointsByTime = new Map(asRows<DbRow>(aggregateRows).map((row) => [numberValue(row.t), {
    t: numberValue(row.t), navPerShare: textValue(row.nav_per_share), nav: textValue(row.nav),
  }]));
  for (const row of asRows<DbRow>(rawRows)) {
    const point = {
      t: numberValue(row.t), navPerShare: textValue(row.nav_per_share), nav: textValue(row.nav),
    };
    pointsByTime.set(point.t, point);
  }
  const points = [...pointsByTime.values()].sort((left, right) => left.t - right.t);
  if (points.length === 0) return [];
  const step = 60 * 60;
  const end = Math.floor(now.getTime() / (step * 1000)) * step;
  const slots = range === "1W" ? 168 : range === "1M" ? 720 : undefined;
  const start = Math.max(slots ? end - (slots - 1) * step : points[0]!.t, points[0]!.t);
  const byTime = new Map(points.map((point) => [point.t, point]));
  let last = points[0]!;
  const filled: typeof points = [];
  for (let t = start; t <= end; t += step) {
    const current = byTime.get(t);
    if (current) last = current;
    filled.push(current ?? { t, navPerShare: last.navPerShare, nav: last.nav });
  }
  return filled;
}
