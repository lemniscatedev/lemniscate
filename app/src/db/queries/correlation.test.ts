import { expect, test } from "bun:test";
import type { ApiDependencies } from "../../api/types";
import type { MarketView } from "./markets";
import { correlationMatrix, hourlyReturns, pearson } from "./correlation";
import { marketCorrelation } from "./correlation";

const spots = (market_id: number, values: Array<[number, number]>) =>
  values.map(([t, spot]) => ({ market_id, t, spot: String(spot) }));

test("hourly returns use only exactly adjacent hourly buckets", () => {
  const result = hourlyReturns(spots(1, [[0, 100], [3_600, 101], [7_200, 102]]));
  expect([...result.get(1)!.keys()]).toEqual([3_600, 7_200]);
  expect(result.get(1)!.get(3_600)).toBeCloseTo(Math.log(101 / 100));
  expect(result.get(1)!.get(7_200)).toBeCloseTo(Math.log(102 / 101));
});

test("hourly returns skip missing buckets instead of joining across gaps", () => {
  const result = hourlyReturns(spots(1, [[0, 100], [3_600, 101], [18_000, 110]]));
  expect([...result.get(1)!.keys()]).toEqual([3_600]);
  expect(result.get(1)!.has(18_000)).toBe(false);
});

test("zero and negative spots invalidate returns touching those buckets", () => {
  const result = hourlyReturns(spots(1, [[0, 100], [3_600, 0], [7_200, 102], [10_800, 103], [14_400, -1], [18_000, 105]]));
  expect([...result.get(1)!.keys()]).toEqual([10_800]);
});

test("Pearson correlation handles identical and opposite series", () => {
  const a = new Map(Array.from({ length: 25 }, (_, i) => [i, i + 1]));
  const same = new Map(a);
  const opposite = new Map([...a].map(([t, value]) => [t, -value]));
  expect(pearson(a, same)).toEqual({ value: 1, overlap: 25 });
  expect(pearson(a, opposite)).toEqual({ value: -1, overlap: 25 });
});

test("Pearson correlation reports insufficient overlap and zero variance", () => {
  const a = new Map(Array.from({ length: 19 }, (_, i) => [i, i + 1]));
  expect(pearson(a, new Map(a))).toEqual({ value: null, overlap: 19 });

  const constant = new Map(Array.from({ length: 25 }, (_, i) => [i, 1]));
  const changing = new Map(Array.from({ length: 25 }, (_, i) => [i, i + 1]));
  expect(pearson(constant, changing)).toEqual({ value: null, overlap: 25 });

  const decimalConstant = new Map(Array.from({ length: 25 }, (_, i) => [i, 0.1]));
  expect(pearson(decimalConstant, changing)).toEqual({ value: null, overlap: 25 });
  expect(pearson(decimalConstant, new Map(decimalConstant))).toEqual({ value: null, overlap: 25 });
});

test("correlation matrix is symmetric and diagonals retain their own return counts", () => {
  const a = new Map(Array.from({ length: 25 }, (_, i) => [i, i + 1]));
  const b = new Map([...a].map(([t, value]) => [t, value * -2]));
  const matrix = correlationMatrix(["A", "B"], new Map([[11, a], [12, b]]), [11, 12]);

  expect(matrix.values).toEqual([[1, -1], [-1, 1]]);
  expect(matrix.overlap).toEqual([[25, 25], [25, 25]]);
});

function correlationDeps(
  currentMarkets: () => Array<Pick<MarketView, "id" | "symbol" | "launched">>,
  tickRows: unknown[],
) {
  const sqlCalls: Array<{ query: string; values: unknown[] }> = [];
  const cacheLoads: Array<{ key: string; ttlMs: number }> = [];
  const cached = new Map<string, unknown>();
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    sqlCalls.push({ query: strings.join("?"), values });
    return tickRows;
  };
  const cache = {
    async getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
      cacheLoads.push({ key, ttlMs });
      if (key === "markets:list") return currentMarkets() as T;
      if (cached.has(key)) return cached.get(key) as T;
      const value = await load();
      cached.set(key, value);
      return value;
    },
  };
  return { deps: { sql, cache } as unknown as ApiDependencies, sqlCalls, cacheLoads };
}

test("market correlation queries hourly OPEN buckets and passes the selected day window", async () => {
  const now = new Date("2026-10-08T12:00:00.000Z");
  const rows = Array.from({ length: 26 }, (_, i) => ({ market_id: 1, t: i * 3_600, spot: String(100 + i) }));

  for (const days of [7, 30] as const) {
    const { deps, sqlCalls, cacheLoads } = correlationDeps(
      () => [{ id: 1, symbol: "NVDA", launched: true }],
      [...rows, ...rows.map((row) => ({ ...row, market_id: 999 }))],
    );
    const result = await marketCorrelation(deps, days, now);

    expect(sqlCalls).toHaveLength(1);
    expect(sqlCalls[0]!.query).toContain("regime = 0");
    expect(sqlCalls[0]!.query).toContain("time_bucket(interval '1 hour', ts)");
    expect(sqlCalls[0]!.values).toEqual([now.toISOString(), days, now.toISOString()]);
    expect(result).toMatchObject({ days, symbols: ["NVDA"], values: [[1]], overlap: [[25]] });
    expect(cacheLoads).toContainEqual({ key: `stats:correlation:${days}`, ttlMs: 3_600_000 });
  }
});

test("a warm returns cache follows newly launched markets and ignores unlisted tick ids", async () => {
  const now = new Date("2026-10-08T12:00:00.000Z");
  let markets: Array<Pick<MarketView, "id" | "symbol" | "launched">> = [
    { id: 1, symbol: "NVDA", launched: true },
    { id: 2, symbol: "AMD", launched: false },
  ];
  const rows = [
    ...Array.from({ length: 26 }, (_, i) => ({ market_id: 1, t: i * 3_600, spot: String(100 + i) })),
    ...Array.from({ length: 26 }, (_, i) => ({ market_id: 2, t: i * 3_600, spot: String(200 + i * 2) })),
    ...Array.from({ length: 26 }, (_, i) => ({ market_id: 999, t: i * 3_600, spot: String(50 + i) })),
  ];
  const { deps, sqlCalls } = correlationDeps(() => markets, rows);

  const first = await marketCorrelation(deps, 30, now);
  expect(first.symbols).toEqual(["NVDA"]);
  expect(first.values).toHaveLength(1);

  markets = [
    { id: 1, symbol: "NVDA", launched: true },
    { id: 2, symbol: "AMD", launched: true },
  ];
  const afterLaunch = await marketCorrelation(deps, 30, new Date(now.getTime() + 60_000));
  expect(afterLaunch.symbols).toEqual(["NVDA", "AMD"]);
  expect(afterLaunch.values).toEqual([[1, 1], [1, 1]]);
  expect(afterLaunch.overlap).toEqual([[25, 25], [25, 25]]);
  expect(afterLaunch.asOf).toBe(now.toISOString());
  expect(sqlCalls).toHaveLength(1);

  markets = [{ id: 2, symbol: "AMD", launched: true }];
  const afterHide = await marketCorrelation(deps, 30, new Date(now.getTime() + 120_000));
  expect(afterHide.symbols).toEqual(["AMD"]);
  expect(afterHide.values).toEqual([[1]]);
  expect(sqlCalls).toHaveLength(1);
});
