import { expect, test } from "bun:test";
import { earningsSymbols } from "../../config/earnings";
import { earningsDaysUntil, mergeEarnings, pastEarnings, type EarningsDbRow, type MergedRow } from "./earnings";

const sourceUrl = "https://ir.example.com/events";

test("mergeEarnings prefers complete overrides, drops past dates, and sorts by date then symbol", () => {
  const dbRows: EarningsDbRow[] = [
    { symbol: "TSLA", date: "2026-10-31", session: "unknown", source: "alphavantage" },
    { symbol: "TSLA", date: "2026-11-02", session: "pre", source: "alphavantage" },
    { symbol: "AAPL", date: "2026-11-01", session: "post", source: "alphavantage" },
    { symbol: "AAPL", date: "2026-11-03", session: "unknown", source: "alphavantage" },
    { symbol: "SPY", date: "2026-11-01", session: "post", source: "alphavantage" },
  ];
  const overrides = [
    { symbol: "TSLA", date: "2026-11-02", session: "post" as const, confirmed: true, sourceUrl },
  ];

  expect(mergeEarnings(dbRows, overrides, "2026-11-01")).toEqual([
    { symbol: "AAPL", date: "2026-11-01", session: "post", confirmed: false, source: "alphavantage", sourceUrl: null },
    { symbol: "TSLA", date: "2026-11-02", session: "post", confirmed: true, source: "override", sourceUrl },
    { symbol: "AAPL", date: "2026-11-03", session: "unknown", confirmed: false, source: "alphavantage", sourceUrl: null },
  ]);
});

test("earningsDaysUntil stays calendar-based across the DST change", () => {
  expect(earningsDaysUntil("2026-11-02", "2026-11-01")).toBe(1);
  expect(earningsDaysUntil("2026-11-03", "2026-11-01")).toBe(2);
});

test("earningsSymbols excludes ETF and crypto underlyings", () => {
  expect(earningsSymbols(["nvda", "SPY", "QQQ", "GLD"], ["AAPL", "ETH", "BTC", "NVDA"]))
    .toEqual(["AAPL", "NVDA"]);
});

test("pastEarnings merges historical rows within the requested range", async () => {
  const statements: { query: string; values: unknown[] }[] = [];
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    statements.push({ query, values });
    return [
      { symbol: "TSLA", date: "2026-07-22", session: "post", source: "alphavantage" },
      { symbol: "PLTR", date: "2026-07-31", session: "post", source: "alphavantage" },
      { symbol: "AAPL", date: "2026-06-01", session: "post", source: "alphavantage" },
    ];
  };
  const overrides = [
    { symbol: "TSLA", date: "2026-07-22", session: "post" as const, confirmed: true, sourceUrl },
  ];
  const rows = await pastEarnings({ sql } as never, "2026-07-01", "2026-08-01", overrides);

  expect(statements[0]?.query).toContain("report_date between ?::date and ?::date");
  expect(statements[0]?.values).toEqual(["2026-07-01", "2026-08-01"]);
  const expected: MergedRow[] = [
    { symbol: "TSLA", date: "2026-07-22", session: "post", confirmed: true, source: "override", sourceUrl },
    { symbol: "PLTR", date: "2026-07-31", session: "post", confirmed: false, source: "alphavantage", sourceUrl: null },
  ];
  expect(rows).toEqual(expected);
});
