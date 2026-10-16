import { fetchJsonWithTimeout } from "../http";
import type { KeeperContext } from "../context";
import { fixed } from "../../lib/fixed";

export interface RefQuote {
  stock: string;
  symbol: string;
  bid: string | null;
  ask: string | null;
  tokenBid: string | null;
  tokenAsk: string | null;
  dailyHigh: string | null;
  dailyLow: string | null;
  dailyVolume: string | null;
  mintBurnUsd: string | null;
  halt: boolean;
  generatedAt: Date;
}

type ObjectValue = Record<string, unknown>;

const ET_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
});
const ET_TIME_FORMATTER = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

export function flowDate(generatedAt: Date): string {
  return ET_DATE_FORMATTER.format(generatedAt);
}

function minutesAfterEtMidnight(value: Date): number {
  const parts = ET_TIME_FORMATTER.formatToParts(value);
  const hour = Number(parts.find((part) => part.type === "hour")?.value ?? 0);
  const minute = Number(parts.find((part) => part.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

export function nextFlowValue(
  previous: { value: string; firstSeenAt: Date } | null,
  incoming: string,
  now: Date,
): string {
  if (previous === null) return incoming;

  const previousValue = fixed(previous.value);
  const incomingValue = fixed(incoming);
  const earlyDay = flowDate(previous.firstSeenAt) === flowDate(now)
    && minutesAfterEtMidnight(previous.firstSeenAt) < 6 * 60;
  if (incomingValue * 2n < previousValue && earlyDay) return incoming;
  return incomingValue > previousValue ? incoming : previous.value;
}

function object(value: unknown): ObjectValue {
  return value && typeof value === "object" && !Array.isArray(value) ? value as ObjectValue : {};
}

function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function numericString(value: unknown): string | null {
  return typeof value === "string" && /^\d+(?:\.\d+)?$/.test(value) ? value : null;
}

export function normalizeQuotes(payload: unknown): RefQuote[] {
  const newestByStock = new Map<string, RefQuote>();
  for (const value of array(object(payload).quotes)) {
    const quote = object(value);
    const deployment = array(quote.deployments)
      .map(object)
      .find((candidate) => Number(candidate.chainId) === 4663);
    if (!deployment || typeof deployment.contractAddress !== "string"
      || !/^0x[0-9a-fA-F]{40}$/.test(deployment.contractAddress)) continue;

    const symbol = quote.tokenSymbol;
    if (typeof symbol !== "string" || !/^[A-Z0-9.\-]{1,16}$/.test(symbol)) continue;
    const generatedAt = new Date(String(quote.generatedAt));
    if (!Number.isFinite(generatedAt.getTime())) continue;

    const stock = deployment.contractAddress.toLowerCase();
    const normalized: RefQuote = {
      stock,
      symbol,
      bid: numericString(quote.bid),
      ask: numericString(quote.ask),
      tokenBid: numericString(quote.tokenBid),
      tokenAsk: numericString(quote.tokenAsk),
      dailyHigh: numericString(quote.dailyHigh),
      dailyLow: numericString(quote.dailyLow),
      dailyVolume: numericString(quote.dailyTradingVolume),
      mintBurnUsd: numericString(quote.mintBurnUsdVolume),
      halt: quote.isTradingHalt === true,
      generatedAt,
    };
    const previous = newestByStock.get(stock);
    if (!previous || normalized.generatedAt.getTime() > previous.generatedAt.getTime()) {
      newestByStock.set(stock, normalized);
    }
  }
  return [...newestByStock.values()];
}

export async function updateReferencePrices(context: KeeperContext): Promise<Record<string, unknown>> {
  const payload = await fetchJsonWithTimeout("https://api.robinhood.com/rhj/prices/");
  const quotes = normalizeQuotes(payload);
  if (quotes.length === 0) throw new Error("Robinhood prices returned no quotes");

  const rows = quotes.map((quote) => ({
    stock: quote.stock,
    symbol: quote.symbol,
    bid: quote.bid,
    ask: quote.ask,
    token_bid: quote.tokenBid,
    token_ask: quote.tokenAsk,
    daily_high: quote.dailyHigh,
    daily_low: quote.dailyLow,
    daily_volume: quote.dailyVolume,
    mint_burn_usd: quote.mintBurnUsd,
    halt: quote.halt,
    generated_at: quote.generatedAt.toISOString(),
  }));
  const columns = [
    "stock", "symbol", "bid", "ask", "token_bid", "token_ask", "daily_high", "daily_low",
    "daily_volume", "mint_burn_usd", "halt", "generated_at",
  ] as const;
  await context.sql`insert into ref_prices ${context.sql(rows, ...columns)}
    on conflict (stock) do update set stock=excluded.stock, symbol=excluded.symbol, bid=excluded.bid, ask=excluded.ask,
      token_bid=excluded.token_bid, token_ask=excluded.token_ask, daily_high=excluded.daily_high,
      daily_low=excluded.daily_low, daily_volume=excluded.daily_volume, mint_burn_usd=excluded.mint_burn_usd,
      halt=excluded.halt, generated_at=excluded.generated_at, fetched_at=now()`;

  const flowQuotes = quotes.filter((quote) => quote.mintBurnUsd !== null);
  if (flowQuotes.length > 0) {
    const stocks = flowQuotes.map((quote) => quote.stock);
    const dates = flowQuotes.map((quote) => flowDate(quote.generatedAt));
    const stockArray = context.sql.array(stocks, 25);
    // Drizzle overrides date-array handlers; encode text and let Postgres cast the elements.
    const dateArray = context.sql.array(dates, 25);
    const priorRows = await context.sql<{
      stock: string;
      flow_date: string;
      mint_burn_usd: string;
      first_seen_at: Date | string;
    }[]>`select stock, flow_date::text as flow_date, mint_burn_usd::text as mint_burn_usd, first_seen_at
      from token_flow
      where (stock, flow_date) in (select * from unnest(${stockArray}::text[], ${dateArray}::text[]::date[]))`;
    const priorByKey = new Map(priorRows.map((row) => [`${row.stock}:${row.flow_date}`, row]));
    const updatedAt = new Date().toISOString();
    const flowRows = flowQuotes.map((quote) => {
      const date = flowDate(quote.generatedAt);
      const previous = priorByKey.get(`${quote.stock}:${date}`);
      return {
        stock: quote.stock,
        flow_date: date,
        symbol: quote.symbol,
        mint_burn_usd: nextFlowValue(
          previous ? { value: previous.mint_burn_usd, firstSeenAt: new Date(previous.first_seen_at) } : null,
          quote.mintBurnUsd!,
          quote.generatedAt,
        ),
        first_seen_at: quote.generatedAt.toISOString(),
        updated_at: updatedAt,
      };
    });
    const flowColumns = ["stock", "flow_date", "symbol", "mint_burn_usd", "first_seen_at", "updated_at"] as const;
    await context.sql`insert into token_flow ${context.sql(flowRows, ...flowColumns)}
      on conflict (stock, flow_date) do update set mint_burn_usd=excluded.mint_burn_usd,
        symbol=excluded.symbol, updated_at=excluded.updated_at`;
  }
  await context.sql`delete from token_flow where flow_date < current_date - 120`;

  const newestQuoteAt = quotes.reduce(
    (newest, quote) => Math.max(newest, quote.generatedAt.getTime()),
    0,
  );
  return { stored: quotes.length, newestQuoteAt: new Date(newestQuoteAt).toISOString(), flowRows: flowQuotes.length };
}
