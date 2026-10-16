import { apiNow } from "../../api/clock";
import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows, dateValue, textValue } from "../../api/types";
import { listMarkets } from "./markets";
import { isLaunched } from "../../config/launch";

interface TokenFlowDayRow extends DbRow {
  flow_date: string;
  mint_burn_usd: string;
  updated_at?: Date | string | null;
}

interface HottestTokenRow extends DbRow {
  symbol: string;
  stock: string;
  mint_burn_usd: string;
  fetched_at: Date | string;
}

export interface MarketTokenFlow {
  symbol: string;
  todayUsd: string | null;
  asOf: string;
  days: { date: string; mintBurnUsd: string }[];
}

export interface HottestTokens {
  asOf: string;
  tokens: { symbol: string; mintBurnUsd: string; listedOnLemniscate: boolean }[];
}

function addCalendarDays(date: string, days: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
}

export function flowSeries(
  rows: { flow_date: string; mint_burn_usd: string }[],
  days: number,
  todayEt: string,
): { date: string; mintBurnUsd: string }[] {
  const values = new Map(rows.map((row) => [row.flow_date, row.mint_burn_usd]));
  const firstDay = addCalendarDays(todayEt, 1 - days);
  return Array.from({ length: days }, (_, index) => {
    const date = addCalendarDays(firstDay, index);
    return { date, mintBurnUsd: values.get(date) ?? "0" };
  });
}

export async function marketTokenFlow(
  deps: ApiDependencies,
  symbol: string,
  days: 7 | 30,
  requestedNow?: Date,
): Promise<MarketTokenFlow | null> {
  const now = requestedNow ?? await apiNow(deps);
  const markets = await deps.cache.getOrLoad("markets:list", 3_000, () => listMarkets(deps));
  const market = markets.find((candidate) => candidate.symbol.toUpperCase() === symbol.toUpperCase());
  if (!market) return null;

  // MarketView intentionally omits the stock address, so resolve it after the cached public market lookup.
  const stockResult = await deps.sql`select stock from markets where id = ${market.id} limit 1`;
  const stock = textValue(asRows<DbRow>(stockResult)[0]?.stock).toLowerCase();
  if (!stock) return null;

  const todayEt = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(now);
  const startDate = addCalendarDays(todayEt, 1 - days);
  const result = await deps.sql<TokenFlowDayRow[]>`
    select flow_date::text as flow_date, mint_burn_usd::text as mint_burn_usd, updated_at
    from token_flow
    where stock = ${stock} and flow_date >= ${startDate}::date and flow_date <= ${todayEt}::date
    order by flow_date asc
  `;
  const rows = asRows<TokenFlowDayRow>(result);
  const today = rows.find((row) => row.flow_date === todayEt);
  const todayUpdatedAt = dateValue(today?.updated_at);
  const todayUsd = todayUpdatedAt && now.getTime() - todayUpdatedAt.getTime() <= 15 * 60_000
    ? textValue(today?.mint_burn_usd, "0")
    : null;
  const latestUpdatedAt = rows.reduce<Date | null>((latest, row) => {
    const updatedAt = dateValue(row.updated_at);
    return updatedAt && (!latest || updatedAt > latest) ? updatedAt : latest;
  }, null);

  return {
    symbol: market.symbol,
    todayUsd,
    asOf: (latestUpdatedAt ?? now).toISOString(),
    days: flowSeries(rows, days, todayEt),
  };
}

export async function hottestTokens(
  deps: ApiDependencies,
  limit: number,
  requestedNow?: Date,
): Promise<HottestTokens> {
  const now = requestedNow ?? await apiNow(deps);
  const nowIso = now.toISOString();
  const [rows, launchResult] = await Promise.all([
    deps.cache.getOrLoad(`stats:token-flow:data:${limit}`, 60_000, async () => asRows<HottestTokenRow>(await deps.sql<HottestTokenRow[]>`
      select r.symbol, r.stock, r.mint_burn_usd::text as mint_burn_usd, r.fetched_at
      from ref_prices r
      where r.fetched_at >= ${nowIso}::timestamptz - interval '10 minutes' and r.mint_burn_usd > 0
      order by r.mint_burn_usd desc limit ${limit}
    `)),
    deps.sql`select m.stock, m.symbol, ml.launched
      from markets m left join market_launch ml on upper(ml.symbol) = upper(m.symbol)`,
  ]);
  const launchedMarkets = new Set(asRows<DbRow>(launchResult)
    .filter((row) => isLaunched(textValue(row.symbol), typeof row.launched === "boolean" ? row.launched : undefined))
    .map((row) => `${textValue(row.stock).toLowerCase()}:${textValue(row.symbol).toUpperCase()}`));
  const latestFetchedAt = rows.reduce<Date | null>((latest, row) => {
    const fetchedAt = dateValue(row.fetched_at);
    return fetchedAt && (!latest || fetchedAt > latest) ? fetchedAt : latest;
  }, null);
  return {
    asOf: (latestFetchedAt ?? now).toISOString(),
    tokens: rows.map((row) => ({
      symbol: textValue(row.symbol),
      mintBurnUsd: textValue(row.mint_burn_usd, "0"),
      listedOnLemniscate: launchedMarkets.has(`${textValue(row.stock).toLowerCase()}:${textValue(row.symbol).toUpperCase()}`),
    })),
  };
}
