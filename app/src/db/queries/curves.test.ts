import { expect, test } from "bun:test";
import { TtlCache } from "../../api/cache";
import type { ApiDependencies } from "../../api/types";
import { upcomingMarketConfig } from "../../config/upcoming";
import { buildCurveTable, CURVE_MOVES, marketCurves } from "./curves";
import type { MarketView } from "./markets";
import type { MarketVol } from "./vol";

const asOf = new Date("2026-10-08T12:00:00.000Z");

test("buildCurveTable assigns live, coming and preview statuses", () => {
  const table = buildCurveTable({
    symbol: "NVDA",
    underlying: "NVDA",
    liveCurve: "squared",
    sigmaAnnual: 0.5,
    sigmaSource: "realized30d",
    liveDailyCarryPct: 0.081,
    upcoming: [
      { underlying: "NVDA", curve: "root", symbol: "NVDAROOT" },
      { underlying: "NVDA", curve: "downside", symbol: "NVDAINV" },
      { underlying: "QQQ", curve: "cubed", symbol: "QQQ3" },
    ],
    asOf,
  });

  expect(table).toMatchObject({
    symbol: "NVDA", underlying: "NVDA", sigmaAnnualPct: 50, sigmaSource: "realized30d",
    moves: [...CURVE_MOVES], asOf: asOf.toISOString(),
  });
  expect(table.curves.map(({ curve, status, marketSymbol }) => ({ curve, status, marketSymbol }))).toEqual([
    { curve: "squared", status: "live", marketSymbol: "NVDA" },
    { curve: "cubed", status: "preview", marketSymbol: null },
    { curve: "root", status: "coming", marketSymbol: "NVDAROOT" },
    { curve: "downside", status: "coming", marketSymbol: "NVDAINV" },
  ]);
  expect(table.curves.every((row) => row.payoffs.length === 6)).toBe(true);
  expect(table.curves.find(({ curve }) => curve === "root")?.carryDirection).toBe("holder_receives");
  expect(table.curves[0]?.liveDailyCarryPct).toBe(0.081);
  expect(table.curves.slice(1).every((row) => row.liveDailyCarryPct === null)).toBe(true);
});

test("buildCurveTable keeps every carry null when volatility is unavailable", () => {
  const table = buildCurveTable({
    symbol: "QQQ",
    underlying: "QQQ",
    liveCurve: "squared",
    sigmaAnnual: null,
    sigmaSource: null,
    liveDailyCarryPct: 0.04,
    upcoming: upcomingMarketConfig,
    asOf,
  });
  expect(table.sigmaAnnualPct).toBeNull();
  expect(table.sigmaSource).toBeNull();
  expect(table.curves.every((row) => row.fairCarryDailyPct === null
    && row.fairCarryAnnualPct === null && row.carryDirection === null)).toBe(true);
});

test("marketCurves reuses the shared market and volatility cache entries", async () => {
  const cache = new TtlCache();
  const market = { symbol: "NVDA", underlying: "NVDA", curve: "squared", launched: true, dailyCarryPct: 0.081 };
  const vol = { symbol: "NVDA", realized30dPct: null, realized7dPct: 45 };
  await cache.getOrLoad("markets:list", 3_000, async () => [market]);
  await cache.getOrLoad("vol:all", 600_000, async () => [vol]);
  const calls: { key: string; ttl: number }[] = [];
  const original = cache.getOrLoad.bind(cache);
  cache.getOrLoad = (key, ttl, load) => {
    calls.push({ key, ttl });
    return original(key, ttl, load);
  };

  const deps = { cache, sql: async () => { throw new Error("Expected cached data"); } } as unknown as ApiDependencies;
  const result = await marketCurves(deps, "nvda", asOf);

  expect(result?.sigmaAnnualPct).toBe(45);
  expect(result?.sigmaSource).toBe("realized7d");
  expect(result?.asOf).toBe(asOf.toISOString());
  expect(calls).toEqual([{ key: "markets:list", ttl: 3_000 }, { key: "vol:all", ttl: 600_000 }]);
});

test("marketCurves hides unlaunched markets before loading volatility", async () => {
  const cache = new TtlCache();
  await cache.getOrLoad("markets:list", 3_000, async () => [
    { symbol: "NVDA", underlying: "NVDA", curve: "squared", launched: false, dailyCarryPct: 0.081 } as unknown as MarketView,
  ]);
  const deps = { cache, sql: async () => { throw new Error("A hidden market must not load more data"); } } as unknown as ApiDependencies;
  expect(await marketCurves(deps, "NVDA", asOf)).toBeNull();
});
