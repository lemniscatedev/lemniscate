import { expect, test } from "bun:test";
import type { ApiDependencies } from "../../api/types";
import { buildDailySeries, marketShares, protocolHistory } from "./analytics";

const DAY = 86_400;
const START = Date.parse("2026-10-01T00:00:00Z") / 1000;

test("daily series fills every day in the range with zeros", () => {
  const points = buildDailySeries(START, START + 2 * DAY + 3_600, [
    { t: String(START + DAY), volume: "30", buy_volume: "20", sell_volume: "10", fees: "0.3", trades: 3, traders: 2 },
  ], [], null);
  expect(points.map((point) => point.t)).toEqual([START, START + DAY, START + 2 * DAY]);
  expect(points[0]).toEqual({ t: START, volumeUsd: "0", buyVolumeUsd: "0", sellVolumeUsd: "0", feesUsd: "0", trades: 0, uniqueTraders: 0, tvlUsd: null });
  expect(points[1]).toMatchObject({ volumeUsd: "30", buyVolumeUsd: "20", sellVolumeUsd: "10", feesUsd: "0.3", trades: 3, uniqueTraders: 2 });
  expect(points[2]).toMatchObject({ volumeUsd: "0", trades: 0, uniqueTraders: 0 });
});

test("daily series carries vault TVL forward from the seed", () => {
  const points = buildDailySeries(START, START + 2 * DAY, [], [{ t: START + DAY, tvl: "120" }], "100");
  expect(points.map((point) => point.tvlUsd)).toEqual(["100", "120", "120"]);
});

test("daily series leaves TVL null until the first tick without a seed", () => {
  const points = buildDailySeries(START, START + 2 * DAY, [], [{ t: START + DAY, tvl: "120" }], null);
  expect(points.map((point) => point.tvlUsd)).toEqual([null, "120", "120"]);
});

test("daily series returns one point when start and end are equal", () => {
  expect(buildDailySeries(START, START, [], [], null)).toHaveLength(1);
});

test("market shares split range volume", () => {
  const shares = marketShares([{ symbol: "NVDA", volume: "30", trades: 2 }, { symbol: "TSLA", volume: "10", trades: 1 }]);
  expect(shares).toEqual([
    { symbol: "NVDA", volumeUsd: "30", trades: 2, sharePct: 75 },
    { symbol: "TSLA", volumeUsd: "10", trades: 1, sharePct: 25 },
  ]);
});

test("market shares are zero when there is no volume", () => {
  const shares = marketShares([{ symbol: "NVDA", volume: "0", trades: 0 }, { symbol: "TSLA", volume: "0", trades: 0 }]);
  expect(shares.map((share) => share.sharePct)).toEqual([0, 0]);
  expect(shares.some((share) => Number.isNaN(share.sharePct))).toBe(false);
});

test("protocol history computes market shares against every indexed market", async () => {
  const deps = depsFor((query) => {
    if (query.includes("sum(t.usdg)::text")) return [
      { symbol: "SPY", volume: "30", trades: 2 },
      { symbol: "SPYROOT", volume: "20", trades: 1 },
      { symbol: "SPCX", volume: "10", trades: 1 },
    ];
    return [];
  });
  const result = await protocolHistory(deps, "7D", new Date("2026-10-08T12:00:00Z"));
  expect(result.markets.map((market) => market.symbol)).toEqual(["SPY", "SPYROOT", "SPCX"]);
  expect(result.markets.map((market) => market.sharePct)).toEqual([50, 33.3333, 16.6667]);
});

function depsFor(rows: (query: string, values: unknown[]) => unknown[], calls: Array<{ query: string; values: unknown[] }> = []) {
  return {
    config: { NETWORK: "mainnet" },
    sql: async (strings: TemplateStringsArray, ...values: unknown[]) => {
      const query = strings.join("?");
      calls.push({ query, values });
      return rows(query, values);
    },
  } as unknown as ApiDependencies;
}

test("all-time history is empty when nothing has been indexed", async () => {
  const now = new Date("2026-10-07T15:00:00Z");
  const result = await protocolHistory(depsFor((query) => (query.includes("least(") ? [{ first: null }] : [])), "ALL", now);
  expect(result).toEqual({
    range: "ALL", from: now.toISOString(), to: now.toISOString(),
    summary: { volumeUsd: "0", buyVolumeUsd: "0", sellVolumeUsd: "0", feesUsd: "0", trades: 0, uniqueTraders: 0 },
    points: [], markets: [],
  });
});

test("seven-day history starts at UTC midnight seven days back", async () => {
  const calls: Array<{ query: string; values: unknown[] }> = [];
  const now = new Date("2026-10-07T15:00:00Z");
  const result = await protocolHistory(depsFor(() => [], calls), "7D", now);
  const daily = calls.find((call) => call.query.includes("from trades") && call.query.includes("group by 1"));
  expect(daily?.values).toEqual(["2026-09-30T00:00:00.000Z", now.toISOString()]);
  expect(result.from).toBe("2026-09-30T00:00:00.000Z");
  expect(result.points).toHaveLength(8);
  expect(result.summary.trades).toBe(0);
  expect(result.points.every((point) => point.tvlUsd === null)).toBe(true);
});

test("all-time history starts on the first indexed day", async () => {
  const now = new Date("2026-10-07T15:00:00Z");
  const first = Date.parse("2026-10-05T13:20:00Z") / 1000;
  const result = await protocolHistory(depsFor((query) => {
    if (query.includes("least(")) return [{ first: String(first) }];
    if (query.includes("ts < ")) return [];
    return query.includes("last(total_assets") ? [{ t: String(Date.parse("2026-10-05T00:00:00Z") / 1000), tvl: "100" }] : [];
  }), "ALL", now);
  expect(result.from).toBe("2026-10-05T00:00:00.000Z");
  expect(result.points.map((point) => point.tvlUsd)).toEqual(["100", "100", "100"]);
});
