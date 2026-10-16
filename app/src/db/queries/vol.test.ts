import { describe, expect, test } from "bun:test";
import type { ApiDependencies } from "../../api/types";
import { allMarketVols, carryImplied, carryToVariance, realizedVolPct, sortVolBoard, volHistory, type VolPoint } from "./vol";

const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const points = (hours: number, step = HOUR): VolPoint[] =>
  Array.from({ length: hours + 1 }, (_, i) => ({ t: i * step, spot: 100 }));

describe("calendar-time realized volatility", () => {
  test("constant prices have zero volatility", () => {
    expect(realizedVolPct(points(240), 0, 10 * DAY)).toEqual({ pct: 0, samples: 240 });
  });
  test("alternating hourly moves agree with analytic squared log returns", () => {
    const rows = points(240);
    for (let i = 1; i < rows.length; i++) rows[i]!.spot = rows[i - 1]!.spot * (i % 2 ? 1.01 : 0.99);
    const expected = Math.sqrt((120 * Math.log(1.01) ** 2 + 120 * Math.log(0.99) ** 2) / (10 / 365)) * 100;
    expect(realizedVolPct(rows, 0, 10 * DAY).pct).toBeCloseTo(expected, 2);
  });
  test("session gaps count as elapsed time; returns are not demeaned", () => {
    const rows = points(24, 2 * HOUR).map((p, i) => ({ ...p, spot: 100 * Math.exp(i * 0.01) }));
    expect(realizedVolPct(rows, 0, 2 * DAY)).toEqual({ pct: 66.18, samples: 24 });
  });
  test("requires at least 24 returns spanning at least two days", () => {
    expect(realizedVolPct(points(23, 3 * HOUR), 0, 3 * DAY)).toEqual({ pct: null, samples: 23 });
    expect(realizedVolPct(points(47), 0, 3 * DAY)).toEqual({ pct: null, samples: 47 });
    expect(realizedVolPct([], 0, 3 * DAY)).toEqual({ pct: null, samples: 0 });
  });
  test("filters invalid spots and out-of-window points, sorts without mutating", () => {
    const rows = [...points(48), ...[0, -1, NaN, Infinity].map((spot) => ({ t: HOUR, spot })),
      { t: -1, spot: 999 }, { t: 2 * DAY + 1, spot: 999 }].reverse();
    const original = [...rows];
    expect(realizedVolPct(rows, 0, 2 * DAY)).toEqual({ pct: 0, samples: 48 });
    expect(rows).toEqual(original);
  });
});

test("carry implied vol uses a human daily fraction and squared-token variance", () => {
  expect(carryImplied(0.0007)).toEqual({ annualCarryPct: 25.55, carryImpliedPct: 50.55 });
  expect(carryImplied(0)).toEqual({ annualCarryPct: 0, carryImpliedPct: null });
  expect(carryImplied(-0.0007)).toEqual({ annualCarryPct: -25.55, carryImpliedPct: null });
  for (const value of [null, NaN, Infinity]) expect(carryImplied(value)).toEqual({ annualCarryPct: null, carryImpliedPct: null });
});

test("carry / variance rejects missing or zero realized variance", () => {
  expect(carryToVariance(25.55, 50)).toBe(1.02);
  expect(carryToVariance(0, 50)).toBe(0);
  for (const value of [0, -1, null, NaN, Infinity]) expect(carryToVariance(10, value)).toBeNull();
  for (const value of [null, NaN, Infinity]) expect(carryToVariance(value, 50)).toBeNull();
});

test("board orders cheapest first, ties by symbol, nulls last without mutation", () => {
  const rows = [{ symbol: "Z", carryToVariance: null }, { symbol: "B", carryToVariance: 1 },
    { symbol: "A", carryToVariance: 1 }, { symbol: "C", carryToVariance: 0.5 }, { symbol: "D", carryToVariance: null }];
  expect(sortVolBoard(rows).map((r) => r.symbol)).toEqual(["C", "A", "B", "D", "Z"]);
  expect(rows[0]!.symbol).toBe("Z");
});

test("history contains only available trailing seven-day values at the last 30 UTC midnights", () => {
  const now = 40 * DAY + 12 * HOUR;
  const full = volHistory(points(40 * 24), now);
  expect(full).toHaveLength(30);
  expect(full[0]!.t).toBe(11 * DAY);
  expect(full.at(-1)!.t).toBe(40 * DAY);
  expect(full.every((p, i) => p.t % DAY === 0 && p.t <= now && p.realized7dPct === 0 && (!i || p.t > full[i - 1]!.t))).toBe(true);
  expect(volHistory(points(3 * 24), 3 * DAY)).toEqual([{ t: 2 * DAY, realized7dPct: 0 }, { t: 3 * DAY, realized7dPct: 0 }]);
  expect(volHistory([], now)).toEqual([]);
});

test("all markets query hourly open closes and latest carry with the same clock, preserving market order", async () => {
  const now = new Date(10 * DAY);
  const calls: { query: string; values: unknown[] }[] = [];
  const sql = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    calls.push({ query, values });
    if (query.includes("last(t.spot")) return points(10 * 24).map((p) => ({ symbol: "NVDA", t: String(p.t), spot: String(p.spot) }));
    if (query.includes("left join lateral")) return [{ symbol: "EMPTY", carry_wad: null }, { symbol: "NVDA", carry_wad: "0.0007" }];
    throw new Error(`Unexpected query: ${query}`);
  };
  const result = await allMarketVols({ sql } as unknown as ApiDependencies, now);
  expect(calls).toHaveLength(2);
  expect(calls[0]!.query).toContain("t.regime = 0");
  expect(calls[0]!.query).toContain("interval '37 days'");
  expect(calls[0]!.query).toContain("interval '1 hour'");
  expect(calls[0]!.values).toEqual([now.toISOString(), now.toISOString()]);
  expect(calls[1]!.query).toContain("ts <= ?::timestamptz order by ts desc limit 1");
  expect(calls[1]!.values).toEqual([now.toISOString()]);
  expect(result[0]).toEqual({ symbol: "EMPTY", realized7dPct: null, realized30dPct: null, carryImpliedPct: null,
    annualCarryPct: null, carryToVariance: null, samples7d: 0, samples30d: 0, history: [] });
  expect(result[1]).toMatchObject({ symbol: "NVDA", realized7dPct: 0, realized30dPct: 0,
    samples7d: 168, samples30d: 240, annualCarryPct: 25.55, carryImpliedPct: 50.55 });
});
