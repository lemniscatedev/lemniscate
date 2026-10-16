import { expect, test } from "bun:test";
import type { KeeperContext } from "../context";
import { fetchJsonWithTimeout } from "../http";
import { flowDate, nextFlowValue, normalizeQuotes, updateReferencePrices } from "./reference";

const fixture = {
  quotes: [
    {
      tokenSymbol: "CRM",
      deployments: [{ contractAddress: "0xd95B44124e475743a7589e68F3D74008A5536D44", chainId: 4663 }],
      bid: "224.78", ask: "226", tokenBid: "225.038119999144558781", tokenAsk: "226.259520952961430218",
      dailyHigh: "225.1539", dailyLow: "223.01", dailyTradingVolume: "15865", mintBurnUsdVolume: "50.6545813488",
      isTradingHalt: false, generatedAt: "2026-10-08T10:50:42.185010883Z",
    },
    {
      tokenSymbol: "P",
      deployments: [{ contractAddress: "0x1Cdad396DB64BDa184d5182A97Dd9B3C62100b7D", chainId: 4663 }],
      bid: "150.38", ask: "150.99", tokenBid: "150.380000000000000000", tokenAsk: "150.990000000000000000",
      dailyHigh: "155.53", dailyLow: "150.5", dailyTradingVolume: "7265", mintBurnUsdVolume: "5976.46847",
      isTradingHalt: true, generatedAt: "2026-10-08T10:50:42.185010883Z",
    },
    {
      tokenSymbol: "CIEN",
      deployments: [{ contractAddress: "0x44f6D488021f8233B9416294d1FE9b1fEe28382d", chainId: 4663 }],
      bid: "433", ask: "435", tokenBid: "433.000000000000000000", tokenAsk: "435.000000000000000000",
      dailyHigh: "450.06", dailyLow: "431.0754", dailyTradingVolume: "19131", mintBurnUsdVolume: "0",
      isTradingHalt: false, generatedAt: "2026-10-08T10:50:42.185010883Z",
    },
    { tokenSymbol: "MISS", deployments: [], generatedAt: "2026-10-08T10:00:00Z" },
    { tokenSymbol: "CHAIN", deployments: [{ contractAddress: `0x${"1".repeat(40)}`, chainId: 1 }], generatedAt: "2026-10-08T10:00:00Z" },
    { tokenSymbol: "ADDRESS", deployments: [{ contractAddress: "0x1234", chainId: 4663 }], generatedAt: "2026-10-08T10:00:00Z" },
    { tokenSymbol: "NUMBER", deployments: [{ contractAddress: `0x${"2".repeat(40)}`, chainId: 4663 }], bid: 223, generatedAt: "2026-10-08T10:00:00Z" },
    { tokenSymbol: "DATE", deployments: [{ contractAddress: `0x${"3".repeat(40)}`, chainId: 4663 }], generatedAt: "not-a-date" },
    {
      tokenSymbol: "P",
      deployments: [{ contractAddress: "0x1cdad396db64bda184d5182a97dd9b3c62100b7d", chainId: 4663 }],
      bid: "151.1", ask: "151.7", tokenBid: "151.1", tokenAsk: "151.7", dailyHigh: "152", dailyLow: "149",
      dailyTradingVolume: "7266", mintBurnUsdVolume: "5977", isTradingHalt: false,
      generatedAt: "2026-10-08T10:51:42Z",
    },
  ],
};

test("normalizeQuotes keeps valid Robinhood quotes, exact strings, and the newest duplicate", () => {
  expect(normalizeQuotes({ quotes: fixture.quotes.slice(0, 3) }).find((quote) => quote.symbol === "P")?.halt).toBe(true);
  const quotes = normalizeQuotes(fixture);
  expect(quotes).toHaveLength(4);
  const p = quotes.find((quote) => quote.symbol === "P")!;
  expect(p).toMatchObject({
    stock: "0x1cdad396db64bda184d5182a97dd9b3c62100b7d",
    bid: "151.1", ask: "151.7", tokenBid: "151.1", tokenAsk: "151.7",
    dailyHigh: "152", dailyLow: "149", dailyVolume: "7266", mintBurnUsd: "5977", halt: false,
  });
  expect(p.generatedAt.toISOString()).toBe("2026-10-08T10:51:42.000Z");
  expect(quotes.find((quote) => quote.symbol === "CRM")).toMatchObject({
    stock: "0xd95b44124e475743a7589e68f3d74008a5536d44",
    bid: "224.78", tokenBid: "225.038119999144558781", tokenAsk: "226.259520952961430218",
  });
  expect(quotes.find((quote) => quote.symbol === "NUMBER")?.bid).toBeNull();
  expect(quotes.find((quote) => quote.symbol === "CIEN")?.tokenAsk).toBe("435.000000000000000000");
});

function fakeContext(selectRows: unknown[] = []) {
  const statements: { query: string; values: unknown[] }[] = [];
  const inserts: { rows: Record<string, unknown>[]; columns: string[] }[] = [];
  const arrays: { values: unknown[]; type: number | undefined }[] = [];
  const sql = Object.assign((...args: unknown[]) => {
    const first = args[0];
    if (Array.isArray(first) && "raw" in first) {
      const query = (first as TemplateStringsArray).join("?");
      statements.push({ query, values: args.slice(1) });
      return Promise.resolve(query.trimStart().startsWith("select stock, flow_date") ? selectRows : []);
    }
    inserts.push({ rows: first as Record<string, unknown>[], columns: args.slice(1) as string[] });
    return "<quote-rows>";
  }, {
    array: (values: unknown[], type?: number) => {
      arrays.push({ values, type });
      return values;
    },
  });
  return {
    context: { sql, logger: { warn() {} } } as unknown as KeeperContext,
    statements,
    inserts,
    arrays,
  };
}

type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

async function withFetch<T>(fetcher: FetchImplementation, run: () => Promise<T>): Promise<T> {
  const previous = globalThis.fetch;
  globalThis.fetch = fetcher as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = previous;
  }
}

test("flowDate uses the New York calendar day across summer and winter boundaries", () => {
  expect(flowDate(new Date("2026-10-08T03:59:59Z"))).toBe("2026-10-07");
  expect(flowDate(new Date("2026-10-08T04:00:00Z"))).toBe("2026-10-08");
  expect(flowDate(new Date("2026-01-08T04:59:59Z"))).toBe("2026-01-07");
  expect(flowDate(new Date("2026-01-08T05:00:00Z"))).toBe("2026-01-08");
});

test("nextFlowValue keeps the maximum except for an early-day reset", () => {
  const now = new Date("2026-10-08T13:00:00Z");
  expect(nextFlowValue(null, "7.25", now)).toBe("7.25");
  expect(nextFlowValue({ value: "100", firstSeenAt: new Date("2026-10-08T05:00:00Z") }, "110", now)).toBe("110");
  expect(nextFlowValue({ value: "100", firstSeenAt: new Date("2026-10-08T05:00:00Z") }, "90", now)).toBe("100");
  expect(nextFlowValue({ value: "100", firstSeenAt: new Date("2026-10-08T05:00:00Z") }, "49.99", now)).toBe("49.99");
  expect(nextFlowValue({ value: "100", firstSeenAt: new Date("2026-10-08T14:00:00Z") }, "49", now)).toBe("100");
});

test("updateReferencePrices records the daily flow in one select and one bulk upsert", async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const { context, statements, inserts, arrays } = fakeContext();
  const result = await withFetch(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(input), init });
    return Response.json(fixture);
  }, () => updateReferencePrices(context));

  expect(calls).toHaveLength(1);
  expect(calls[0]?.url).toBe("https://api.robinhood.com/rhj/prices/");
  expect((calls[0]?.init?.headers as Record<string, string>)?.["User-Agent"]).toBe("lemniscate-keeper/1.0");
  expect((calls[0]?.init?.headers as Record<string, string>)?.Accept).toBe("application/json");
  const refUpsert = statements.find((statement) => statement.query.includes("insert into ref_prices"));
  const flowSelects = statements.filter((statement) => statement.query.trimStart().startsWith("select stock, flow_date"));
  const retention = statements.find((statement) => statement.query.includes("delete from token_flow"));
  expect(refUpsert?.query).toContain("on conflict (stock) do update set");
  expect(refUpsert?.query).toContain("fetched_at=now()");
  expect(flowSelects).toHaveLength(1);
  expect(flowSelects[0]?.query).toContain("unnest(?::text[], ?::text[]::date[])");
  expect(arrays.map(({ type }) => type)).toEqual([25, 25]);
  expect(arrays[0]?.values).toHaveLength(3);
  expect(arrays[1]?.values).toEqual(["2026-10-08", "2026-10-08", "2026-10-08"]);
  expect(retention?.query).toContain("flow_date < current_date - 120");
  expect(inserts).toHaveLength(2);
  expect(inserts[0]?.rows).toHaveLength(4);
  expect(inserts[0]?.rows[0]).toHaveProperty("token_bid");
  expect(inserts[1]?.columns).toEqual(["stock", "flow_date", "symbol", "mint_burn_usd", "first_seen_at", "updated_at"]);
  expect(inserts[1]?.rows).toHaveLength(3);
  expect(inserts[1]?.rows[0]).toMatchObject({ flow_date: "2026-10-08" });
  expect(result).toEqual({ stored: 4, newestQuoteAt: "2026-10-08T10:51:42.000Z", flowRows: 3 });
});

test("updateReferencePrices handles a prior flow row with the driver's timestamp string", async () => {
  const { context, inserts } = fakeContext([{
    stock: "0xd95b44124e475743a7589e68f3d74008a5536d44",
    flow_date: "2026-10-08",
    mint_burn_usd: "200",
    first_seen_at: "2026-10-08 05:00:00+00",
  }]);
  await withFetch(async () => Response.json(fixture), () => updateReferencePrices(context));

  expect(inserts[1]?.rows[0]).toMatchObject({
    stock: "0xd95b44124e475743a7589e68f3d74008a5536d44",
    mint_burn_usd: "50.6545813488",
  });
});

test("updateReferencePrices skips quotes without a string mintBurnUsdVolume", async () => {
  const { context, inserts } = fakeContext();
  const payload = { quotes: [
    fixture.quotes[0],
    { ...fixture.quotes[1], mintBurnUsdVolume: 5976 },
  ] };
  const result = await withFetch(async () => Response.json(payload), () => updateReferencePrices(context));

  expect(inserts).toHaveLength(2);
  expect(inserts[0]?.rows).toHaveLength(2);
  expect(inserts[1]?.rows).toHaveLength(1);
  expect(result).toMatchObject({ stored: 2, flowRows: 1 });
});

test("updateReferencePrices rejects empty data and hides URL queries on HTTP errors", async () => {
  const { context } = fakeContext();
  await withFetch(async () => Response.json({ quotes: [] }), async () => {
    await expect(updateReferencePrices(context)).rejects.toThrow("Robinhood prices returned no quotes");
  });

  await withFetch(async () => new Response("unavailable", { status: 503 }), async () => {
    await expect(updateReferencePrices(context)).rejects.toThrow("api.robinhood.com returned HTTP 503");
  });

  await withFetch(async () => new Response("unavailable", { status: 503 }), async () => {
    await expect(fetchJsonWithTimeout("https://api.robinhood.com/rhj/prices/?apikey=secret"))
      .rejects.toThrow("api.robinhood.com returned HTTP 503");
  });
});
