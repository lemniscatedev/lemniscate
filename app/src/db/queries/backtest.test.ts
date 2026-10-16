import { expect, test } from "bun:test";
import { TtlCache } from "../../api/cache";
import type { ApiDependencies } from "../../api/types";
import { decimal, fixed, WAD } from "../../lib/fixed";
import type { MarketView } from "./markets";
import { backtestOutcome, BACKTEST_BUCKETS, fillValueSeries, marketBacktest, spreadForRegime } from "./backtest";

const now = new Date("2026-10-08T12:00:00.000Z");

function outcome(overrides: Partial<Parameters<typeof backtestOutcome>[0]> = {}) {
  return backtestOutcome({
    entryPrice: fixed("10"), entryRegime: 0, entryNorm: fixed("1"), entrySpot: fixed("100"),
    nowPrice: fixed("10"), nowIndex: fixed("10"), nowSpot: fixed("100"),
    feeBps: 0, entrySpreadBps: 0, exitSpreadBps: 0,
    ...overrides,
  });
}

test("backtestOutcome returns fair and net values with no fees or spread", () => {
  const result = outcome();
  expect(result.value).toBe(100n * WAD);
  expect(result.markValue).toBe(100n * WAD);
  expect(result.changePct).toBe(0);
  expect(result.costs).toBe(0n);
  expect(result.carryPct).toBe(0);
});

test("backtestOutcome deducts entry and exit fees using fixed point math", () => {
  const result = outcome({ feeBps: 10, nowPrice: fixed("12") });
  expect(result.tokens).toBe(fixed("9.99"));
  expect(result.markValue).toBe(fixed("119.88"));
  expect(result.value).toBe(fixed("119.76012"));
});

test("backtestOutcome counts both spreads in round-trip costs", () => {
  const result = outcome({ entrySpreadBps: 40, exitSpreadBps: 40 });
  expect(result.value).toBeLessThan(100n * WAD);
  expect(Math.abs(Number(decimal(100n * WAD - result.value - result.costs)))).toBeLessThan(1e-12);
});

test("backtestOutcome derives carry and stock changes from the supplied marks", () => {
  expect(outcome({ entryNorm: fixed("1"), nowPrice: fixed("9.9"), nowIndex: fixed("10") }).carryPct).toBe(1);
  expect(outcome({ nowSpot: fixed("105") }).stockChangePct).toBe(5);
});

test("spreadForRegime selects configured spreads and falls back by regime", () => {
  expect(spreadForRegime({ openSpreadBps: 41, offHoursSpreadBps: 151, pausedSpreadBps: 301 }, 0)).toBe(41);
  expect(spreadForRegime({ openSpreadBps: 41, offHoursSpreadBps: 151, pausedSpreadBps: 301 }, 1)).toBe(151);
  expect(spreadForRegime({ openSpreadBps: 41, offHoursSpreadBps: 151, pausedSpreadBps: 301 }, 2)).toBe(301);
  expect(spreadForRegime({ openSpreadBps: "bad", offHoursSpreadBps: Number.NaN, pausedSpreadBps: null }, 0)).toBe(40);
  expect(spreadForRegime({ openSpreadBps: "bad", offHoursSpreadBps: Number.NaN, pausedSpreadBps: null }, 1)).toBe(150);
  expect(spreadForRegime({ openSpreadBps: "bad", offHoursSpreadBps: Number.NaN, pausedSpreadBps: null }, 2)).toBe(300);
});

test("fillValueSeries carries gaps forward and skips buckets before the first known price", () => {
  const tokens = fixed("2");
  expect(fillValueSeries([
    { t: 3_600, price: "10" },
    { t: 10_800, price: "12" },
  ], tokens, 0, 10_800, 3_600)).toEqual([
    { t: 3_600, valueUsd: "20" },
    { t: 7_200, valueUsd: "20" },
    { t: 10_800, valueUsd: "24" },
  ]);
  expect(fillValueSeries([{ t: 0, price: "10" }], tokens, 0, 7 * 86_400, 3_600)).toHaveLength(169);
});

const cachedMarket = {
  id: 7,
  symbol: "NVDA",
  launched: true,
  price: "12",
  index: "12",
  spot: "105",
  config: { openSpreadBps: 40, offHoursSpreadBps: 150, pausedSpreadBps: 300 },
  quoteParams: { feeBps: 10, spreadBps: 40 },
} as unknown as MarketView;

function dependencies({
  markets = [cachedMarket],
  entryRows = [] as Record<string, unknown>[],
  seriesRows = [] as Record<string, unknown>[],
}: {
  markets?: MarketView[];
  entryRows?: Record<string, unknown>[];
  seriesRows?: Record<string, unknown>[];
} = {}) {
  const cache = new TtlCache();
  const calls: { tagged: { query: string; values: unknown[] }[]; unsafe: { query: string; params: unknown[] }[] } = { tagged: [], unsafe: [] };
  void cache.getOrLoad("markets:list", 3_000, async () => markets);
  const sql = Object.assign(
    async (strings: TemplateStringsArray, ...values: unknown[]) => {
      calls.tagged.push({ query: strings.join("?"), values });
      return entryRows;
    },
    {
      unsafe: async (query: string, params: unknown[]) => {
        calls.unsafe.push({ query, params });
        return seriesRows;
      },
    },
  );
  return {
    deps: { cache, sql } as unknown as ApiDependencies,
    calls,
  };
}

test("marketBacktest returns null for an unknown or unlaunched market", async () => {
  const hidden = dependencies({ markets: [{ ...cachedMarket, launched: false } as unknown as MarketView] });
  expect(await marketBacktest(hidden.deps, "NVDA", 7, now)).toBeNull();
  expect(hidden.calls.tagged).toHaveLength(0);
  const unknown = dependencies({ markets: [] });
  expect(await marketBacktest(unknown.deps, "NOPE", 7, now)).toBeNull();
  expect(unknown.calls.tagged).toHaveLength(0);
});

test("marketBacktest reports unavailable when there is no entry tick", async () => {
  const { deps, calls } = dependencies();
  expect(await marketBacktest(deps, "nvda", 7, now)).toEqual({
    symbol: "NVDA", days: 7, available: false, reason: "Not enough history yet.", points: [],
  });
  expect(calls.unsafe).toHaveLength(0);
});

test("marketBacktest flags history shorter than the requested window", async () => {
  const startAt = new Date(now.getTime() - 20 * 86_400_000);
  const firstBucket = Math.floor(startAt.getTime() / 14_400_000) * 14_400;
  const { deps } = dependencies({
    entryRows: [{ ts: startAt, price: "10", norm_factor: "1", spot: "100", regime: 1 }],
    seriesRows: [{ t: firstBucket, price: "10" }],
  });
  const result = await marketBacktest(deps, "NVDA", 30, now);
  expect(result).toMatchObject({ available: true, shortened: true, actualDays: 20, startAt: startAt.toISOString() });
});

test("marketBacktest uses only fixed bucket intervals and bound market/time values", async () => {
  for (const days of [7, 30] as const) {
    const startAt = new Date(now.getTime() - 3 * 86_400_000);
    const { deps, calls } = dependencies({
      entryRows: [{ ts: startAt, price: "10", norm_factor: "1", spot: "100", regime: 0 }],
      seriesRows: [{ t: Math.floor(startAt.getTime() / 1_000), price: "10" }],
    });
    await marketBacktest(deps, "NVDA", days, now);
    expect(calls.unsafe[0]?.query).toContain(`interval '${BACKTEST_BUCKETS[days]}'`);
    expect(calls.unsafe[0]?.params).toEqual([7, startAt.toISOString(), now.toISOString()]);
    expect(calls.unsafe[0]?.params).not.toContain(BACKTEST_BUCKETS[days]);
  }
});
