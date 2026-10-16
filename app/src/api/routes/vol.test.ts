import { expect, test } from "bun:test";
import pino from "pino";
import { createApiApp } from "../app";
import { TtlCache } from "../cache";
import type { ApiDependencies } from "../types";
import type { MarketVol } from "../../db/queries/vol";

const header = "public, max-age=300, stale-while-revalidate=600";
const boardHeader = "public, max-age=5, stale-while-revalidate=30";

async function fixture() {
  const cache = new TtlCache();
  const markets: MarketVol[] = [
    { symbol: "Z", carryToVariance: null }, { symbol: "NVDA", carryToVariance: 1.02 },
    { symbol: "AAPL", carryToVariance: 1.02 }, { symbol: "SPY", carryToVariance: 0.5 },
  ].map((row) => ({ realized7dPct: 40, realized30dPct: 50, carryImpliedPct: 50.55,
    annualCarryPct: 25.55, samples7d: 49, samples30d: 200, history: [{ t: 0, realized7dPct: 40 }], ...row }));
  await cache.getOrLoad("vol:all", 600_000, async () => markets);
  await cache.getOrLoad("markets:list", 3_000, async () => markets.map(({ symbol }) => ({ symbol, launched: true })));
  const calls: { key: string; ttl: number }[] = [];
  const original = cache.getOrLoad.bind(cache);
  cache.getOrLoad = (key, ttl, load) => { calls.push({ key, ttl }); return original(key, ttl, load); };
  const app = createApiApp({
    sql: async () => { throw new Error("The shared cached result should be reused"); },
    config: { CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet" },
    deployment: {}, logger: pino({ level: "silent" }), cache,
  } as unknown as ApiDependencies);
  return { app, calls };
}

test("volatility returns 404 for unknown symbols and 400 for invalid input", async () => {
  const { app } = await fixture();
  const unknown = await app.request("/v1/markets/NOPE/vol");
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: "NOT_FOUND", message: "Unknown market symbol: NOPE" });
  const invalid = await app.request("/v1/markets/ABCDEFGHIJKLMNOPQRST/vol");
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: "BAD_REQUEST" });
});

test("market and board share a ten-minute cache; board is sorted without history", async () => {
  const { app, calls } = await fixture();
  const detail = await app.request("/v1/markets/nvda/vol");
  expect(detail.status).toBe(200);
  expect(detail.headers.get("cache-control")).toBe(header);
  expect(await detail.json()).toMatchObject({ symbol: "NVDA", history: [{ t: 0, realized7dPct: 40 }] });
  const response = await app.request("/v1/stats/vol");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe(boardHeader);
  const body = await response.json() as { asOf: string; markets: Record<string, unknown>[] };
  expect(Number.isFinite(Date.parse(body.asOf))).toBe(true);
  expect(body.markets.map((row) => row.symbol)).toEqual(["SPY", "AAPL", "NVDA", "Z"]);
  expect(body.markets.every((row) => !("history" in row))).toBe(true);
  expect(calls).toEqual([
    { key: "vol:all", ttl: 600_000 },
    { key: "vol:all", ttl: 600_000 }, { key: "markets:list", ttl: 3_000 },
  ]);
});
