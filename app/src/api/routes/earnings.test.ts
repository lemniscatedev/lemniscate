import { expect, test } from "bun:test";
import pino from "pino";
import { createApiApp } from "../app";
import { TtlCache } from "../cache";
import type { ApiDependencies } from "../types";

class MutableMarketCache extends TtlCache {
  launched = true;

  override async getOrLoad<T>(key: string, ttlMs: number, load: () => Promise<T>): Promise<T> {
    if (key === "markets:list") {
      const market = {
        id: 1,
        symbol: "TSLA",
        curve: "squared",
        underlying: "TSLA",
        launched: this.launched,
        price: "250",
        change24hPct: 1.25,
        dailyCarryPct: 0.03,
      };
      return (this.launched ? [market] : []) as T;
    }
    return super.getOrLoad(key, ttlMs, load);
  }
}

function appWithEarnings(rows: unknown[], symbol = "TSLA", injectedCache?: TtlCache) {
  const cache = injectedCache ?? new TtlCache();
  if (!injectedCache) {
    void cache.getOrLoad("markets:list", 3_000, async () => [{
      id: 1,
      symbol,
      curve: "squared",
      underlying: symbol,
      launched: true,
      price: "250",
      change24hPct: 1.25,
      dailyCarryPct: 0.03,
    }]);
  }
  const sql = async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("from earnings")) return rows;
    if (query.includes("from keeper_status where job = 'indexer'")) {
      return [{ meta: {
        chainTimestamp: Math.floor(Date.parse("2026-10-08T14:00:00.000Z") / 1_000),
        chainTimeObservedAt: new Date().toISOString(),
      } }];
    }
    return [];
  };
  return createApiApp({
    sql,
    config: { CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "fork" },
    deployment: { markets: [] },
    logger: pino({ level: "silent" }),
    cache,
  } as unknown as ApiDependencies);
}

test("earnings rejects invalid day windows and returns the documented response shape", async () => {
  const app = appWithEarnings([
    { symbol: "TSLA", date: "2026-10-21", session: "post", source: "alphavantage" },
  ]);

  const invalid = await app.request("/v1/earnings?days=0");
  expect(invalid.status).toBe(400);

  const response = await app.request("/v1/earnings?days=30");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("public, max-age=300, stale-while-revalidate=3600");
  const body = await response.json() as {
    asOf: string; todayEt: string; days: number;
    items: Array<{ symbol: string; date: string; source: string; confirmed: boolean; daysUntil: number; upcoming: boolean; markets: unknown[] }>;
  };
  expect(body.asOf).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(body.days).toBe(30);
  expect(body.items[0]).toMatchObject({ symbol: "TSLA", date: "2026-10-21", source: "override", confirmed: true, upcoming: false });
  expect(body.items[0]?.daysUntil).toBeGreaterThanOrEqual(0);
  expect(body.items[0]?.markets).toEqual([{
    symbol: "TSLA", curve: "squared", price: "250", change24hPct: 1.25, dailyCarryPct: 0.03,
  }]);
});

test("market list responses include a nullable nextEarnings field", async () => {
  const app = appWithEarnings([], "MSFT");
  const response = await app.request("/v1/markets");
  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject([{ symbol: "MSFT", nextEarnings: null }]);
});

test("earnings reattaches only the currently launched markets to its warm response cache", async () => {
  const cache = new MutableMarketCache();
  const app = appWithEarnings([
    { symbol: "TSLA", date: "2026-10-21", session: "post", source: "alphavantage" },
  ], "TSLA", cache);

  const first = await app.request("/v1/earnings?days=30");
  expect((await first.json() as { items: Array<{ markets: Array<{ symbol: string }> }> }).items[0]?.markets)
    .toMatchObject([{ symbol: "TSLA" }]);

  cache.launched = false;
  const hidden = await app.request("/v1/earnings?days=30");
  expect((await hidden.json() as { items: Array<{ markets: unknown[] }> }).items[0]?.markets).toEqual([]);

  cache.launched = true;
  const restored = await app.request("/v1/earnings?days=30");
  expect((await restored.json() as { items: Array<{ markets: Array<{ symbol: string }> }> }).items[0]?.markets)
    .toMatchObject([{ symbol: "TSLA" }]);
});
