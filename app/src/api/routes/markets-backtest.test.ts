import { expect, test } from "bun:test";
import pino from "pino";
import type { MarketView } from "../../db/queries/markets";
import type { ApiDependencies } from "../types";
import { createApiApp } from "../app";
import { TtlCache } from "../cache";
import type { MarketBacktest } from "../../db/queries/backtest";

const market = { id: 1, symbol: "NVDA", launched: true } as unknown as MarketView;
const result: MarketBacktest = {
  symbol: "NVDA", days: 7, available: true, shortened: false, actualDays: 7,
  startAt: "2026-10-01T12:00:00.000Z", endAt: "2026-10-08T12:00:00.000Z", investUsd: "100",
  entryPrice: "10", exitPrice: "11.9", tokens: "9.99", markValueUsd: "119.88", valueUsd: "118.8",
  costsUsd: "1.2", changePct: 18.8, markChangePct: 19.88, stockChangePct: 5, carryPct: 0.1,
  points: [{ t: 1_791_243_600, valueUsd: "119.88" }],
};

async function appWith(launched = true) {
  const cache = new TtlCache();
  await cache.getOrLoad("markets:list", 3_000, async () => [{ ...market, launched }]);
  await cache.getOrLoad("markets:backtest:NVDA:7", 60_000, async () => result);
  const sql = Object.assign(async () => [], { unsafe: async () => [] });
  return {
    app: createApiApp({
      sql,
      config: { CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet" },
      deployment: {},
      logger: pino({ level: "silent" }),
      cache,
    } as unknown as ApiDependencies),
    cache,
  };
}

test("backtest route serves the cached market result and documents the endpoint", async () => {
  const { app } = await appWith();
  const response = await app.request("/v1/markets/nvda/backtest");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("public, max-age=60, stale-while-revalidate=300");
  expect(await response.json()).toMatchObject({ symbol: "NVDA", days: 7, valueUsd: "118.8", points: result.points });

  const openApi = await app.request("/v1/openapi.json");
  expect(openApi.status).toBe(200);
  const document = await openApi.json() as { paths?: Record<string, unknown> };
  expect(document.paths).toHaveProperty("/v1/markets/{symbol}/backtest");
});

test("backtest route rejects invalid windows and returns 404 for unknown symbols", async () => {
  const { app } = await appWith();
  const invalid = await app.request("/v1/markets/NVDA/backtest?days=14");
  expect(invalid.status).toBe(400);
  expect(await invalid.json()).toMatchObject({ error: "BAD_REQUEST" });

  const unknown = await app.request("/v1/markets/NOPE/backtest");
  expect(unknown.status).toBe(404);
  expect(await unknown.json()).toEqual({ error: "NOT_FOUND", message: "Unknown market symbol: NOPE" });
});

test("backtest route checks launch state before using a warm result cache", async () => {
  const { app, cache } = await appWith(false);
  const keys: string[] = [];
  const original = cache.getOrLoad.bind(cache);
  cache.getOrLoad = (key, ttlMs, load) => {
    keys.push(key);
    return original(key, ttlMs, load);
  };

  const response = await app.request("/v1/markets/NVDA/backtest");
  expect(response.status).toBe(404);
  expect(keys).toEqual(["markets:list"]);
});
