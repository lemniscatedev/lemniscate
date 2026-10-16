import { earningsSymbols } from "../../config/earnings";
import { upcomingMarketConfig } from "../../config/upcoming";
import { decodeKind, underlyingOf } from "../../lib/market-kind";
import { fetchTextWithTimeout } from "../http";
import { saveJobMeta, type IndexerMetadata, type KeeperContext } from "../context";

const providerUrl = "https://www.alphavantage.co/query?function=EARNINGS_CALENDAR&horizon=3month&apikey=";

export interface EarningsRow {
  symbol: string;
  reportDate: string;
  session: "pre" | "post" | "unknown";
  fiscalDateEnding: string | null;
}

interface CsvColumnMap {
  symbol: number;
  reportDate: number;
  fiscalDateEnding: number;
  timeOfTheDay: number;
}

function splitCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index]!;
    if (character === '"') {
      if (quoted && line[index + 1] === '"') {
        field += '"';
        index += 1;
      } else {
        quoted = !quoted;
      }
    } else if (character === "," && !quoted) {
      fields.push(field);
      field = "";
    } else {
      field += character;
    }
  }
  fields.push(field);
  return fields.map((value) => value.trim());
}

function validDate(value: string | undefined): value is string {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

function columnMap(header: string[]): CsvColumnMap {
  return {
    symbol: header.indexOf("symbol"),
    reportDate: header.indexOf("reportDate"),
    fiscalDateEnding: header.indexOf("fiscalDateEnding"),
    timeOfTheDay: header.indexOf("timeOfTheDay"),
  };
}

export function parseEarningsCsv(text: string, wanted: ReadonlySet<string>): EarningsRow[] {
  const lines = text.split("\n").map((line) => line.replace(/\r$/, ""));
  const firstLine = lines[0]?.replace(/^\uFEFF/, "") ?? "";
  if (!firstLine.startsWith("symbol,")) throw new Error("Alpha Vantage returned no CSV");

  const columns = columnMap(splitCsvLine(firstLine));
  if (columns.symbol < 0 || columns.reportDate < 0) throw new Error("Alpha Vantage returned no CSV");

  const rows: EarningsRow[] = [];
  for (const line of lines.slice(1)) {
    if (!line.trim()) continue;
    const values = splitCsvLine(line);
    const symbol = values[columns.symbol]?.toUpperCase();
    const reportDate = values[columns.reportDate];
    if (!symbol || !wanted.has(symbol) || !validDate(reportDate)) continue;
    const timeOfTheDay = columns.timeOfTheDay >= 0 ? values[columns.timeOfTheDay]?.toLowerCase() : undefined;
    const session = timeOfTheDay === "pre-market" ? "pre" : timeOfTheDay === "post-market" ? "post" : "unknown";
    const fiscalDateEnding = values[columns.fiscalDateEnding];
    rows.push({
      symbol,
      reportDate,
      session,
      fiscalDateEnding: validDate(fiscalDateEnding) ? fiscalDateEnding : null,
    });
  }
  return rows;
}

interface EarningsJobMeta {
  lastFetchDate?: string;
  failureDate?: string;
  failuresToday?: number;
}

function jobMeta(value: unknown): EarningsJobMeta {
  return value && typeof value === "object" && !Array.isArray(value) ? value as EarningsJobMeta : {};
}

function marketUnderlyings(metadata: IndexerMetadata): string[] {
  return Object.values(metadata.marketsById ?? {}).map((market) => {
    const rawKind = market.config.kind;
    const kind = typeof rawKind === "number" ? rawKind : Number(rawKind);
    return underlyingOf(market.symbol, decodeKind(kind).curve);
  });
}

async function storedJobMeta(context: KeeperContext): Promise<EarningsJobMeta> {
  const rows = await context.sql<{ meta: unknown }[]>`select meta from keeper_status where job = 'earnings'`;
  return jobMeta(rows[0]?.meta);
}

async function persistFailure(context: KeeperContext, today: string, previousCount: number): Promise<void> {
  await saveJobMeta(context, "earnings", {
    failureDate: today,
    failuresToday: previousCount + 1,
    error: null,
    skipped: null,
  });
}

async function recordFailedAttempt(context: KeeperContext, today: string, previousCount: number, error: unknown): Promise<never> {
  await persistFailure(context, today, previousCount);
  if (error instanceof Error) throw error;
  throw new Error("Alpha Vantage request failed");
}

export async function updateEarnings(context: KeeperContext): Promise<Record<string, unknown>> {
  const metadata = await context.metadata();
  const today = context.now(metadata).toISOString().slice(0, 10);
  const previous = await storedJobMeta(context);
  if (previous.lastFetchDate === today) return {};

  if (!context.config.ALPHAVANTAGE_API_KEY) {
    return { skipped: "no key", lastFetchDate: today, error: null };
  }

  const previousFailures = previous.failureDate === today && Number.isInteger(previous.failuresToday)
    ? Math.max(0, previous.failuresToday!)
    : 0;
  if (previousFailures >= 3) {
    return { skipped: "retry cap", failureDate: today, failuresToday: previousFailures, error: null };
  }

  const wanted = new Set(earningsSymbols(
    marketUnderlyings(metadata),
    upcomingMarketConfig.map((item) => item.underlying),
  ));

  let text: string;
  try {
    text = await fetchTextWithTimeout(`${providerUrl}${encodeURIComponent(context.config.ALPHAVANTAGE_API_KEY)}`, { timeoutMs: 20_000 });
  } catch (error) {
    return recordFailedAttempt(context, today, previousFailures, error);
  }

  let rows: EarningsRow[];
  try {
    rows = parseEarningsCsv(text, wanted);
  } catch (error) {
    if (error instanceof Error && error.message === "Alpha Vantage returned no CSV") {
      return { lastFetchDate: today, error: "no csv", skipped: null, failuresToday: 0, failureDate: today };
    }
    return recordFailedAttempt(context, today, previousFailures, error);
  }

  try {
    await context.sql.begin(async (transaction) => {
      await transaction`delete from earnings where source = 'alphavantage' and report_date >= ${today}::date`;
      for (const row of rows) {
        await transaction`insert into earnings (symbol, report_date, session, fiscal_date_ending, source)
          values (${row.symbol}, ${row.reportDate}::date, ${row.session}, ${row.fiscalDateEnding}::date, 'alphavantage')
          on conflict (symbol, report_date, source) do update set
            session = excluded.session, fiscal_date_ending = excluded.fiscal_date_ending, fetched_at = now()`;
      }
    });
  } catch (error) {
    return recordFailedAttempt(context, today, previousFailures, error);
  }

  return {
    lastFetchDate: today,
    rows: rows.length,
    symbols: wanted.size,
    error: null,
    skipped: null,
    failureDate: today,
    failuresToday: 0,
  };
}
