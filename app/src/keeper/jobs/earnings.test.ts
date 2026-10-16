import { expect, test } from "bun:test";
import { loadConfig, safeConfigSummary, type RuntimeConfig } from "../../config";
import type { KeeperContext } from "../context";
import { earningsSymbols } from "../../config/earnings";
import { COMPANY_IR_SOURCE, parseEarningsCsv, syncCompanyIrEarnings, updateEarnings } from "./earnings";

const wanted = new Set(["AAPL", "TSLA", "AMD"]);

test("parseEarningsCsv filters symbols and invalid dates while respecting commas in quoted names", () => {
  const csv = [
    "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay",
    'AAPL,"Apple, Inc.",2026-10-29,2026-09-26,1.0,USD,pre-market',
    "TSLA,Tesla Inc,2026-10-21,2026-09-30,1.0,USD,post-market",
    "SPY,SPDR S&P 500 ETF,2026-10-21,2026-09-30,1.0,USD,post-market",
    "AMD,Advanced Micro Devices,2026-02-30,2025-12-27,1.0,USD,post-market",
  ].join("\n");

  expect(parseEarningsCsv(csv, wanted)).toEqual([
    { symbol: "AAPL", reportDate: "2026-10-29", session: "pre", fiscalDateEnding: "2026-09-26" },
    { symbol: "TSLA", reportDate: "2026-10-21", session: "post", fiscalDateEnding: "2026-09-30" },
  ]);
});

test("parseEarningsCsv maps optional session values and treats other values as unknown", () => {
  const csv = [
    "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay",
    "AAPL,Apple,2026-10-29,2026-09-26,1.0,USD,pre-market",
    "TSLA,Tesla,2026-10-21,2026-09-30,1.0,USD,post-market",
    "AMD,AMD,2026-11-03,2026-09-26,1.0,USD,during-market",
  ].join("\n");
  const rows = parseEarningsCsv(csv, wanted);
  expect(rows.map((row) => row.session)).toEqual(["pre", "post", "unknown"]);
});

test("parseEarningsCsv rejects Alpha Vantage notice bodies", () => {
  expect(() => parseEarningsCsv('{"Note":"Thank you for using Alpha Vantage"}', wanted))
    .toThrow("Alpha Vantage returned no CSV");
  expect(() => parseEarningsCsv("symbol,name,fiscalDateEnding\nAAPL,Apple,2026-09-26", wanted))
    .toThrow("Alpha Vantage returned no CSV");
});

test("earningsSymbols removes ETFs and crypto from the unique sorted union", () => {
  expect(earningsSymbols(["nvda", "SPY", "AAPL"], ["NVDA", "ETH", "PLTR", "BTC"]))
    .toEqual(["AAPL", "NVDA", "PLTR"]);
});

test("config exposes only whether the Alpha Vantage key is configured", () => {
  const config = loadConfig({ DATABASE_URL: "postgres://lemniscate:lemniscate@localhost:5432/lemniscate", POSTGRES_PASSWORD: "lemniscate" });
  expect(config.ALPHAVANTAGE_API_KEY).toBe("");
  const configured = loadConfig({
    DATABASE_URL: "postgres://lemniscate:lemniscate@localhost:5432/lemniscate",
    POSTGRES_PASSWORD: "lemniscate",
    ALPHAVANTAGE_API_KEY: "private-provider-key",
  });
  expect(safeConfigSummary(configured).alphaVantageKeyConfigured).toBe(true);
  expect(JSON.stringify(safeConfigSummary(configured))).not.toContain("private-provider-key");
});

type Statement = { query: string; values: unknown[] };
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

function fakeContext(options: { key?: string; jobMeta?: Record<string, unknown> } = {}) {
  const statements: Statement[] = [];
  const logs: string[] = [];
  let jobMeta = options.jobMeta ?? {};
  const query = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const text = strings.join("?");
    statements.push({ query: text, values });
    if (text.includes("select meta from keeper_status where job = 'earnings'")) return [{ meta: jobMeta }];
    if (text.includes("insert into keeper_status (job, meta)")) {
      const update = JSON.parse(String(values[1])) as Record<string, unknown>;
      jobMeta = { ...jobMeta, ...update };
    }
    return [];
  };
  const transaction = async (callback: (tx: typeof query) => Promise<void>) => callback(query);
  const sql = Object.assign(query, { begin: transaction });
  const context = {
    sql,
    config: { ALPHAVANTAGE_API_KEY: options.key ?? "" } as RuntimeConfig,
    metadata: async () => ({}),
    deployment: { stocks: [{ name: "NVDA" }, { name: "TSLA" }, { name: "SPY" }] },
    now: () => new Date("2026-10-08T14:00:00.000Z"),
    logger: {
      info: (value: unknown) => logs.push(String(value)),
      warn: (value: unknown) => logs.push(String(value)),
      error: (value: unknown) => logs.push(String(value)),
    },
  } as unknown as KeeperContext;
  return { context, statements, logs, getMeta: () => jobMeta };
}

async function withFetch<T>(fetcher: FetchImplementation, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

test("updateEarnings skips without a key and after today's successful fetch", async () => {
  const withoutKey = fakeContext();
  let calls = 0;
  await withFetch(async () => { calls += 1; return new Response(""); }, async () => {
    expect(await updateEarnings(withoutKey.context)).toMatchObject({ skipped: "no key", lastFetchDate: "2026-10-08", error: null });
  });
  expect(calls).toBe(0);

  const alreadyFetched = fakeContext({ key: "provider-secret", jobMeta: { lastFetchDate: "2026-10-08" } });
  await withFetch(async () => { calls += 1; return new Response(""); }, async () => {
    expect(await updateEarnings(alreadyFetched.context)).toEqual({});
  });
  expect(calls).toBe(0);
});

test("updateEarnings replaces current and future Alpha Vantage rows in one transaction", async () => {
  const fixture = [
    "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay",
    "TSLA,Tesla Inc,2026-10-21,2026-09-30,1.0,USD,post-market",
    "SPY,SPDR S&P 500 ETF,2026-10-21,2026-09-30,1.0,USD,post-market",
    "NVDA,NVIDIA Corporation,2026-11-17,2026-10-25,1.0,USD,",
  ].join("\n");
  const { context, statements, logs } = fakeContext({ key: "provider-secret" });
  const urls: string[] = [];
  const result = await withFetch(async (input) => {
    urls.push(String(input));
    return new Response(fixture, { status: 200 });
  }, () => updateEarnings(context));

  expect(urls).toHaveLength(1);
  expect(urls[0]).toContain("apikey=provider-secret");
  const deletion = statements.find((statement) => statement.query.includes("delete from earnings"));
  expect(deletion?.query).toContain("report_date >= ?::date");
  expect(deletion?.values).toEqual(["2026-10-08"]);
  const inserts = statements.filter((statement) => statement.query.includes("insert into earnings"));
  expect(inserts).toHaveLength(2);
  expect(inserts.map((statement) => statement.values.slice(0, 4))).toEqual([
    ["TSLA", "2026-10-21", "post", "2026-09-30"],
    ["NVDA", "2026-11-17", "unknown", "2026-10-25"],
  ]);
  expect(result).toMatchObject({ lastFetchDate: "2026-10-08", rows: 2, failuresToday: 0 });
  expect(JSON.stringify(logs)).not.toContain("provider-secret");
  expect(JSON.stringify(logs)).not.toContain("apikey=");
});

test("updateEarnings treats a non-CSV notice as the daily result and preserves stored rows", async () => {
  const { context, statements } = fakeContext({ key: "provider-secret" });
  const result = await withFetch(async () => new Response('{"Note":"rate limit"}', { status: 200 }),
    () => updateEarnings(context));
  expect(result).toMatchObject({ lastFetchDate: "2026-10-08", error: "no csv", skipped: null });
  expect(statements.some((statement) => statement.query.includes("delete from earnings"))).toBe(false);
});

test("updateEarnings clears stale error and skip markers after a later successful import", async () => {
  const fixture = [
    "symbol,name,reportDate,fiscalDateEnding,estimate,currency,timeOfTheDay",
    "TSLA,Tesla Inc,2026-10-21,2026-09-30,1.0,USD,post-market",
  ].join("\n");
  const { context } = fakeContext({
    key: "provider-secret",
    jobMeta: { lastFetchDate: "2026-10-07", error: "no csv", skipped: "retry cap" },
  });
  const result = await withFetch(async () => new Response(fixture, { status: 200 }), () => updateEarnings(context));

  expect(result).toMatchObject({ lastFetchDate: "2026-10-08", error: null, skipped: null, rows: 1 });
});

test("updateEarnings persists a capped failure count without leaking the provider key", async () => {
  const { context, statements, logs, getMeta } = fakeContext({
    key: "provider-secret",
    jobMeta: { failureDate: "2026-10-07", failuresToday: 2, error: "no csv", skipped: "old skip" },
  });
  let calls = 0;
  await withFetch(async (input) => {
    calls += 1;
    throw new Error(`failed ${String(input)}`);
  }, async () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await expect(updateEarnings(context)).rejects.toThrow("www.alphavantage.co request failed");
    }
    expect(await updateEarnings(context)).toMatchObject({ skipped: "retry cap", failuresToday: 3, error: null });
  });

  expect(calls).toBe(3);
  expect(getMeta()).toMatchObject({ failureDate: "2026-10-08", failuresToday: 3 });
  expect(getMeta()).toMatchObject({ error: null, skipped: null });
  expect(statements.filter((statement) => statement.query.includes("insert into keeper_status (job, meta)"))).toHaveLength(3);
  expect(JSON.stringify(logs)).not.toContain("provider-secret");
  expect(JSON.stringify(logs)).not.toContain("apikey=");
});

test("syncCompanyIrEarnings stores only confirmed future company dates under its own source", async () => {
  const { context, statements } = fakeContext();
  const result = await syncCompanyIrEarnings(context);
  const deletion = statements.find((statement) => statement.query.includes("delete from earnings"));
  expect(deletion?.values).toEqual([COMPANY_IR_SOURCE, "2026-10-08"]);
  const inserts = statements.filter((statement) => statement.query.includes("insert into earnings"));
  expect(inserts).toHaveLength(result.rows);
  const symbols = inserts.map((statement) => statement.values[0]);
  expect(symbols).toContain("NVDA");
  expect(symbols).toContain("TSLA");
  expect(symbols).not.toContain("PLTR"); // confirmed = false in the override file
  expect(inserts.every((statement) => statement.values.at(-1) === COMPANY_IR_SOURCE)).toBe(true);
});
