import { expect, test } from "bun:test";
import pino from "pino";
import { createApiApp } from "../app";
import { TtlCache } from "../cache";
import type { ApiDependencies } from "../types";
import type { MarketView } from "../../db/queries/markets";
import type { MarketVol } from "../../db/queries/vol";

const market = {
  symbol: "NVDA", underlying: "NVDA", curve: "squared", launched: true, dailyCarryPct: 0.081,
};
const vol = {
  symbol: "NVDA", realized7dPct: 45, realized30dPct: 42.1, carryImpliedPct: 56,
  annualCarryPct: 31, carryToVariance: 1.7, samples7d: 100, samples30d: 600, history: [],
};

async function appWith(
  markets: Array<Record<string, unknown>> = [market],
  vols: Array<Record<string, unknown>> = [vol],
) {
  const cache = new TtlCache();
  await cache.getOrLoad("markets:list", 3_000, async () => markets as unknown as MarketView[]);
  await cache.getOrLoad("vol:all", 600_000, async () => vols as unknown as MarketVol[]);
  return createApiApp({
    sql: async () => { throw new Error("The cached market and volatility results should be reused"); },
    config: { CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet" },
    deployment: {},
    logger: pino({ level: "silent" }),
    cache,
  } as unknown as ApiDependencies);
}

test("curve comparison returns four curves and six moves for a launched market", async () => {
  const app = await appWith();
  const response = await app.request("/v1/markets/nvda/curves");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=300");
  const body = await response.json() as {
    symbol: string;
    sigmaSource: string | null;
    curves: Array<{ curve: string; status: string; payoffs: unknown[] }>;
  };
  expect(body.symbol).toBe("NVDA");
  expect(body.sigmaSource).toBe("realized30d");
  expect(body.curves).toHaveLength(4);
  expect(body.curves.map(({ curve, status }) => ({ curve, status }))).toEqual([
    { curve: "squared", status: "live" },
    { curve: "cubed", status: "preview" },
    { curve: "root", status: "coming" },
    { curve: "downside", status: "coming" },
  ]);
  expect(body.curves.every((row) => row.payoffs.length === 6)).toBe(true);
});

test("curve comparison hides unknown and unlaunched markets", async () => {
  const app = await appWith([{ ...market, launched: false }]);
  const unknown = await app.request("/v1/markets/NOPE/curves");
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: "NOT_FOUND", message: "Unknown market symbol: NOPE" });
  const hidden = await app.request("/v1/markets/NVDA/curves");
  expect(hidden.status).toBe(404);
});

test("curve visibility is checked before a warm comparison cache", async () => {
  const cache = new TtlCache();
  await cache.getOrLoad("markets:list", 3_000, async () => [{ ...market, launched: false }] as unknown as MarketView[]);
  await cache.getOrLoad("markets:curves:NVDA", 60_000, async () => ({ stale: "cached result" }));
  const calls: string[] = [];
  const original = cache.getOrLoad.bind(cache);
  cache.getOrLoad = (key, ttl, load) => {
    calls.push(key);
    return original(key, ttl, load);
  };
  const app = createApiApp({
    sql: async () => { throw new Error("A hidden market must not load data"); },
    config: { CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet" },
    deployment: {}, logger: pino({ level: "silent" }), cache,
  } as unknown as ApiDependencies);

  const response = await app.request("/v1/markets/NVDA/curves");
  expect(response.status).toBe(404);
  expect(calls).toEqual(["markets:list"]);
});
