import { expect, test } from "bun:test";
import { TtlCache } from "../../api/cache";
import type { ApiDependencies } from "../../api/types";
import { fixed } from "../../lib/fixed";
import { holderInsights, marketHolders, type HolderRow } from "./holders";

const price = fixed("2");
const nowMs = Date.parse("2026-10-07T12:00:00Z");
const DAY = 86_400_000;
const aa = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const bb = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const cc = "0xcccccccccccccccccccccccccccccccccccccccc";

function bucket(rows: HolderRow[], label: string) {
  return holderInsights(rows, price, nowMs).distribution.find((entry) => entry.label === label);
}

test("a position worth exactly $10 lands in the $10–100 bucket", () => {
  expect(bucket([{ account: aa, balance: "5" }], "$10–100")?.holders).toBe(1);
  expect(bucket([{ account: aa, balance: "5" }], "<$10")?.holders).toBe(0);
});

test("a position just under $10 lands in the <$10 bucket", () => {
  expect(bucket([{ account: aa, balance: "4.999" }], "<$10")?.holders).toBe(1);
});

test("concentration and bucket sums cover every holder", () => {
  const result = holderInsights([
    { account: aa, balance: "50" },
    { account: bb, balance: "30" },
    { account: cc, balance: "20" },
  ], price, nowMs);
  expect(result.holders).toBe(3);
  expect(result.totalSupply).toBe("100");
  expect(result.top1SharePct).toBe(50);
  expect(result.top10SharePct).toBe(100);
  expect(result.distribution.reduce((sum, entry) => sum + entry.holders, 0)).toBe(3);
  expect(result.distribution.reduce((sum, entry) => sum + entry.supplySharePct, 0)).toBeCloseTo(100, 6);
  expect(result.distribution.find((entry) => entry.label === "$100–1k")).toEqual({
    label: "$100–1k", minUsd: "100", maxUsd: "1000", holders: 1, supplySharePct: 50,
  });
  expect(result.distribution.at(-1)).toMatchObject({ label: "≥$10k", minUsd: "10000", maxUsd: null });
  expect(result.topHolders[0]).toEqual({ rank: 1, address: aa, balance: "50", valueUsd: "100", sharePct: 50 });
  expect(result.topHolders.map((row) => row.rank)).toEqual([1, 2, 3]);
});

test("top holders stop at ten", () => {
  const rows = Array.from({ length: 12 }, (_, index) => ({ account: `0x${String(index).padStart(40, "0")}`, balance: "1" }));
  const result = holderInsights(rows, price, nowMs);
  expect(result.topHolders).toHaveLength(10);
  expect(result.top10SharePct).toBe(83.3333);
});

test("no holders returns empty buckets and null concentration", () => {
  const result = holderInsights([], price, nowMs);
  expect(result.holders).toBe(0);
  expect(result.totalSupply).toBe("0");
  expect(result.top1SharePct).toBeNull();
  expect(result.top10SharePct).toBeNull();
  expect(result.newHolders7d).toBe(0);
  expect(result.distribution).toHaveLength(5);
  for (const entry of result.distribution) {
    expect(entry.holders).toBe(0);
    expect(entry.supplySharePct).toBe(0);
  }
  expect(result.topHolders).toEqual([]);
});

test("new holders count first acquisitions on or after seven days ago", () => {
  const result = holderInsights([
    { account: aa, balance: "3", first_at: new Date(nowMs - 7 * DAY + 1_000) },
    { account: bb, balance: "2", first_at: new Date(nowMs - 7 * DAY - 1_000) },
    { account: cc, balance: "1", first_at: null },
  ], price, nowMs);
  expect(result.newHolders7d).toBe(1);
  expect(holderInsights([{ account: aa, balance: "1", first_at: new Date(nowMs - 7 * DAY) }], price, nowMs).newHolders7d).toBe(1);
});

function depsWith(calls: Array<{ query: string; values: unknown[] }>, rows: HolderRow[] = []) {
  const cache = new TtlCache();
  void cache.getOrLoad("markets:list", 60_000, async () => [{ id: 1, symbol: "NVDA", token: "0xtok", price: "2" }]);
  return {
    config: { NETWORK: "mainnet" },
    cache,
    deployment: { contracts: { engine: "0xENGINEengineENGINEengineENGINEengine0001", vault: "0xVAULTvaultVAULTvaultVAULTvaultVAULT0002" } },
    sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.push({ query: strings.join("?"), values });
      return rows;
    },
  } as unknown as ApiDependencies;
}

test("unknown market symbols return null without querying balances", async () => {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  expect(await marketHolders(depsWith(calls), "NOPE")).toBeNull();
  expect(calls.some((call) => call.query.includes("from balances"))).toBe(false);
});

test("market holders exclude the zero address, engine and vault", async () => {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const now = new Date("2026-10-07T12:00:00Z");
  const result = await marketHolders(depsWith(calls, [{ account: aa, balance: "5" }]), "nvda", now);
  const call = calls.find((entry) => entry.query.includes("from balances"));
  expect(call?.values).toContain("0xtok");
  expect(call?.values).toContain(1);
  expect(call?.query).toContain("t.recipient = b.account");
  expect(call?.query).toContain("x.to_addr = b.account");
  expect(call?.values).toContainEqual([
    "0x0000000000000000000000000000000000000000",
    "0xengineengineengineengineengineengine0001",
    "0xvaultvaultvaultvaultvaultvaultvault0002",
  ]);
  expect(result).toMatchObject({ symbol: "NVDA", priceUsd: "2", asOf: "2026-10-07T12:00:00.000Z", holders: 1 });
});
