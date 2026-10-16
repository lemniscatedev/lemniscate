import { apiNow } from "../../api/clock";
import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows } from "../../api/types";
import { earningsOverrides, NO_EARNINGS, type EarningsOverride } from "../../config/earnings";
import { upcomingMarketConfig } from "../../config/upcoming";
import { listMarkets, type MarketView } from "./markets";

const DAY_MS = 86_400_000;

export interface EarningsDbRow extends DbRow {
  symbol: string;
  date: string;
  session: string;
  source?: string;
}

export interface MergedRow {
  symbol: string;
  date: string;
  session: "pre" | "post" | "unknown";
  confirmed: boolean;
  source: "override" | "alphavantage";
  sourceUrl: string | null;
}

export interface NextEarnings {
  date: string;
  session: "pre" | "post" | "unknown";
  confirmed: boolean;
  daysUntil: number;
}

export interface EarningsMarket {
  symbol: string;
  curve: string;
  price: string;
  change24hPct: number;
  dailyCarryPct: number;
}

export interface EarningsItem extends MergedRow {
  daysUntil: number;
  upcoming: boolean;
  markets: EarningsMarket[];
}

export interface EarningsResponse {
  asOf: string;
  todayEt: string;
  days: number;
  items: EarningsItem[];
}

const etDate = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
});

export function earningsTodayEt(now: Date): string {
  return etDate.format(now);
}

export function earningsDaysUntil(date: string, todayEt: string): number {
  return (Date.parse(date) - Date.parse(todayEt)) / DAY_MS;
}

function shiftDate(date: string, days: number): string {
  return new Date(Date.parse(date) + days * DAY_MS).toISOString().slice(0, 10);
}

function sessionValue(value: string): "pre" | "post" | "unknown" {
  return value === "pre" || value === "post" ? value : "unknown";
}

function mergeInWindow(
  dbRows: EarningsDbRow[],
  overrides: EarningsOverride[],
  includeDate: (date: string) => boolean,
  preferOverride: (symbol: string, rows: EarningsOverride[]) => boolean,
): MergedRow[] {
  const dbBySymbol = new Map<string, EarningsDbRow[]>();
  const overrideBySymbol = new Map<string, EarningsOverride[]>();
  for (const row of dbRows) {
    const symbol = row.symbol.toUpperCase();
    if (NO_EARNINGS.has(symbol)) continue;
    const rows = dbBySymbol.get(symbol) ?? [];
    rows.push({ ...row, symbol });
    dbBySymbol.set(symbol, rows);
  }
  for (const row of overrides) {
    const symbol = row.symbol.toUpperCase();
    if (NO_EARNINGS.has(symbol)) continue;
    const rows = overrideBySymbol.get(symbol) ?? [];
    rows.push({ ...row, symbol });
    overrideBySymbol.set(symbol, rows);
  }

  const symbols = new Set([...dbBySymbol.keys(), ...overrideBySymbol.keys()]);
  const merged: MergedRow[] = [];
  for (const symbol of symbols) {
    const symbolOverrides = overrideBySymbol.get(symbol) ?? [];
    const useOverrides = symbolOverrides.length > 0 && preferOverride(symbol, symbolOverrides);
    if (useOverrides) {
      for (const row of symbolOverrides) {
        if (!includeDate(row.date)) continue;
        merged.push({
          symbol,
          date: row.date,
          session: row.session,
          confirmed: row.confirmed,
          source: "override",
          sourceUrl: row.sourceUrl,
        });
      }
    } else {
      for (const row of dbBySymbol.get(symbol) ?? []) {
        if (!includeDate(row.date)) continue;
        merged.push({
          symbol,
          date: row.date,
          session: sessionValue(row.session),
          confirmed: false,
          source: "alphavantage",
          sourceUrl: null,
        });
      }
    }
  }
  return merged.sort((a, b) => a.date.localeCompare(b.date) || a.symbol.localeCompare(b.symbol));
}

export function mergeEarnings(
  dbRows: EarningsDbRow[],
  overrides: EarningsOverride[],
  todayEt: string,
): MergedRow[] {
  const overrideCutoff = shiftDate(todayEt, -1);
  return mergeInWindow(
    dbRows,
    overrides,
    (date) => date >= todayEt,
    (_symbol, rows) => rows.some((row) => row.date >= overrideCutoff),
  );
}

async function queryMergedEarnings(
  deps: ApiDependencies,
  days: number,
  now: Date,
  overrides = earningsOverrides,
): Promise<{ todayEt: string; items: Array<MergedRow & { daysUntil: number }> }> {
  const todayEt = earningsTodayEt(now);
  const result = await deps.sql`
    select symbol, report_date::text as date, session, source
    from earnings
    where report_date between ${todayEt}::date and ${todayEt}::date + ${days}::int
  `;
  const items = mergeEarnings(asRows<EarningsDbRow>(result), overrides, todayEt)
    .map((row) => ({ ...row, daysUntil: earningsDaysUntil(row.date, todayEt) }))
    .filter((row) => row.daysUntil <= days);
  return { todayEt, items };
}

function earningsMarket(market: MarketView): EarningsMarket {
  return {
    symbol: market.symbol,
    curve: market.curve,
    price: market.price,
    change24hPct: market.change24hPct,
    dailyCarryPct: market.dailyCarryPct,
  };
}

export function attachEarningsMarkets(
  items: Array<MergedRow & { daysUntil: number }>,
  markets: MarketView[],
): EarningsItem[] {
  const marketsByUnderlying = new Map<string, EarningsMarket[]>();
  for (const market of markets) {
    if (!market.launched) continue;
    const underlying = market.underlying.toUpperCase();
    const matches = marketsByUnderlying.get(underlying) ?? [];
    matches.push(earningsMarket(market));
    marketsByUnderlying.set(underlying, matches);
  }
  const upcomingUnderlyings = new Set(upcomingMarketConfig.map((item) => item.underlying.toUpperCase()));
  return items.map((row) => {
    const rowMarkets = marketsByUnderlying.get(row.symbol) ?? [];
    return {
      ...row,
      upcoming: rowMarkets.length === 0 && upcomingUnderlyings.has(row.symbol),
      markets: rowMarkets,
    };
  });
}

export async function upcomingEarnings(
  deps: ApiDependencies,
  days: number,
  requestedNow?: Date,
): Promise<EarningsResponse> {
  const now = requestedNow ?? await apiNow(deps);
  const { todayEt, items } = await queryMergedEarnings(deps, days, now);
  const markets = await deps.cache.getOrLoad("markets:list", 3_000, () => listMarkets(deps));
  return {
    asOf: now.toISOString(),
    todayEt,
    days,
    items: attachEarningsMarkets(items, markets),
  };
}

export async function nextEarningsBySymbol(
  deps: ApiDependencies,
  requestedNow?: Date,
): Promise<Map<string, NextEarnings>> {
  const now = requestedNow ?? await apiNow(deps);
  const { todayEt, items } = await queryMergedEarnings(deps, 30, now);
  const next = new Map<string, NextEarnings>();
  for (const row of items) {
    if (row.daysUntil < 0 || row.daysUntil > 30 || next.has(row.symbol)) continue;
    next.set(row.symbol, {
      date: row.date,
      session: row.session,
      confirmed: row.confirmed,
      daysUntil: row.daysUntil,
    });
  }
  return next;
}

export async function pastEarnings(
  deps: ApiDependencies,
  fromDate: string,
  toDate: string,
  overrides = earningsOverrides,
): Promise<MergedRow[]> {
  const result = await deps.sql`
    select symbol, report_date::text as date, session, source
    from earnings
    where report_date between ${fromDate}::date and ${toDate}::date
  `;
  const includeDate = (date: string) => date >= fromDate && date <= toDate;
  return mergeInWindow(
    asRows<EarningsDbRow>(result),
    overrides,
    includeDate,
    (_symbol, rows) => rows.some((row) => includeDate(row.date)),
  );
}
