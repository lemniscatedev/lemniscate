import { expect, test } from "bun:test";
import pino from "pino";
import { createApiApp } from "../app";
import { TtlCache } from "../cache";
import type { ApiDependencies } from "../types";

function market(symbol: string, launched: boolean) {
  return {
    id: symbol === "NVDA" ? 1 : 8,
    symbol,
    token: `0x${"1".repeat(40)}`,
    curve: "squared" as const,
    exponent: 2,
    alwaysOpen: false,
    underlying: symbol,
    launched,
    regime: "open" as const,
    session: { open: true, opensAt: null, closesAt: null },
    buysPaused: false,
    spot: "10",
    index: "10",
    price: "10",
    bid: "9",
    ask: "11",
    dailyCarryPct: 0,
    change24hPct: 0,
    volume24hUsd: "0",
    openInterestUsd: "0",
    capacityUsd: "0",
    utilizationPct: 0,
    oracleUpdatedAt: null,
    asOf: null,
    sparkline: [],
    quoteParams: {
      feeBps: 10, spreadBps: 40, bandBps: 100, impactBps: 50,
      maxTradeUsd: "25", minTradeUsd: "1", capacityUsd: "0", globalCapacityUsd: "0",
    },
    config: {},
    stats: { trades24h: 0, holders: 0, buyVolume24hUsd: "0", sellVolume24hUsd: "0" },
  };
}

function appWithMarkets(markets: ReturnType<typeof market>[]) {
  const cache = new TtlCache();
  void cache.getOrLoad("markets:list", 3_000, async () => markets);
  const app = createApiApp({
    sql: async () => [],
    config: { CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet" },
    deployment: { markets: [] },
    logger: pino({ level: "silent" }),
    cache,
  } as unknown as ApiDependencies);
  return { app, cache };
}

test("market list and detail hide unlaunched symbols unless include=upcoming is requested", async () => {
  const listed = market("NVDA", true);
  const hidden = market("SPCX", false);
  const { app, cache } = appWithMarkets([listed, hidden]);
  void cache.getOrLoad("markets:detail:SPCX", 3_000, async () => hidden);

  const defaultList = await app.request("/v1/markets");
  expect(defaultList.status).toBe(200);
  expect((await defaultList.json() as Array<{ symbol: string }>).map((item) => item.symbol)).toEqual(["NVDA"]);

  const upcomingList = await app.request("/v1/markets?include=upcoming");
  expect((await upcomingList.json() as Array<{ symbol: string }>).map((item) => item.symbol)).toEqual(["NVDA", "SPCX"]);
  expect((await app.request("/v1/markets/SPCX")).status).toBe(404);
  expect((await app.request("/v1/markets/SPCX?include=upcoming")).status).toBe(200);
});

test("volatility board filters after the long-lived all-market cache", async () => {
  const { app, cache } = appWithMarkets([market("NVDA", true), market("SPCX", false)]);
  void cache.getOrLoad("vol:all", 600_000, async () => [
    { symbol: "NVDA", realized7dPct: null, realized30dPct: null, carryImpliedPct: null, annualCarryPct: null, carryToVariance: null, samples7d: 0, samples30d: 0, history: [] },
    { symbol: "SPCX", realized7dPct: null, realized30dPct: null, carryImpliedPct: null, annualCarryPct: null, carryToVariance: null, samples7d: 0, samples30d: 0, history: [] },
  ]);
  const response = await app.request("/v1/stats/vol");
  expect(response.status).toBe(200);
  expect((await response.json() as { markets: Array<{ symbol: string }> }).markets.map((item) => item.symbol)).toEqual(["NVDA"]);
});

test("history board filters after its long-lived cache while preserving all-market shares", async () => {
  const listed = market("NVDA", true);
  const hidden = market("SPCX", false);
  const { app, cache } = appWithMarkets([listed, hidden]);
  void cache.getOrLoad("stats:history:7D", 60_000, async () => ({
    range: "7D", from: "2026-10-01T00:00:00.000Z", to: "2026-10-08T00:00:00.000Z",
    summary: { volumeUsd: "60", buyVolumeUsd: "30", sellVolumeUsd: "30", feesUsd: "0", trades: 3, uniqueTraders: 2 },
    points: [],
    markets: [
      { symbol: "NVDA", volumeUsd: "30", trades: 2, sharePct: 50 },
      { symbol: "SPCX", volumeUsd: "30", trades: 1, sharePct: 50 },
    ],
  }));

  const first = await app.request("/v1/stats/history?range=7D");
  expect((await first.json() as { markets: Array<{ symbol: string; volumeUsd: string; trades: number; sharePct: number }> }).markets)
    .toEqual([{ symbol: "NVDA", volumeUsd: "30", trades: 2, sharePct: 50 }]);

  hidden.launched = true;
  const second = await app.request("/v1/stats/history?range=7D");
  expect((await second.json() as { markets: Array<{ symbol: string }> }).markets.map((item) => item.symbol))
    .toEqual(["NVDA", "SPCX"]);
});
