import { expect, test } from "bun:test";
import pino from "pino";
import type { ApiDependencies } from "../types";
import { createApiApp } from "../app";
import { TtlCache } from "../cache";

test("correlation route serves the matrix and appears in OpenAPI", async () => {
  const rows = Array.from({ length: 26 }, (_, i) => ({
    market_id: 1,
    t: i * 3_600,
    spot: String(100 * Math.exp(i * 0.01)),
  }));
  const sql = Object.assign(async () => rows, { unsafe: async () => [] });
  const cache = new TtlCache();
  await cache.getOrLoad("markets:list", 3_000, async () => [
    { id: 1, symbol: "NVDA", launched: true },
  ]);
  const app = createApiApp({
    sql,
    config: { CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet" },
    deployment: {},
    logger: pino({ level: "silent" }),
    cache,
  } as unknown as ApiDependencies);

  const response = await app.request("/v1/stats/correlation?days=7");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=900");
  expect(await response.json()).toMatchObject({
    days: 7,
    minOverlap: 20,
    symbols: ["NVDA"],
    values: [[1]],
    overlap: [[25]],
  });

  const openApi = await app.request("/v1/openapi.json");
  expect(openApi.status).toBe(200);
  expect(await openApi.json()).toHaveProperty("paths./v1/stats/correlation");
});

test("correlation route rejects unsupported day windows", async () => {
  const sql = Object.assign(async () => [], { unsafe: async () => [] });
  const app = createApiApp({
    sql,
    config: { CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet" },
    deployment: {},
    logger: pino({ level: "silent" }),
    cache: new TtlCache(),
  } as unknown as ApiDependencies);

  const response = await app.request("/v1/stats/correlation?days=90");
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "BAD_REQUEST" });
});
