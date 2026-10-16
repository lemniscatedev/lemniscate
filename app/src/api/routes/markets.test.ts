import { expect, test } from "bun:test";
import pino from "pino";
import { createApiApp } from "../app";
import { TtlCache } from "../cache";
import type { ApiDependencies } from "../types";

function appWith(markets: Array<{ id: number; symbol: string; token: string; price: string }>) {
  const cache = new TtlCache();
  void cache.getOrLoad("markets:list", 60_000, async () => markets);
  const sql = async (strings: TemplateStringsArray) => strings.join("?").includes("from balances")
    ? [{ account: "0x3c44cdddb6a900fa2b585dd299e03d12fa4293bc", balance: "5", first_at: new Date() }]
    : [];
  return createApiApp({
    sql,
    config: { CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet" },
    deployment: { contracts: { engine: "0x1111111111111111111111111111111111111111", vault: "0x2222222222222222222222222222222222222222" } },
    logger: pino({ level: "silent" }),
    cache,
  } as unknown as ApiDependencies);
}

test("holders for an unknown market symbol return 404", async () => {
  const response = await appWith([]).request("/v1/markets/NOPE/holders");
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "NOT_FOUND", message: "Unknown market symbol: NOPE" });
});

test("holders for a known market are cached publicly for thirty seconds", async () => {
  const response = await appWith([{ id: 1, symbol: "NVDA", token: "0xtok", price: "2" }]).request("/v1/markets/nvda/holders");
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("public, max-age=30, stale-while-revalidate=120");
  const body = await response.json() as { symbol: string; holders: number; newHolders7d: number; distribution: unknown[]; topHolders: unknown[] };
  expect(body).toMatchObject({ symbol: "NVDA", holders: 1, newHolders7d: 1 });
  expect(body.distribution).toHaveLength(5);
  expect(body.topHolders).toHaveLength(1);
});

test("token flow rejects unsupported day windows", async () => {
  const response = await appWith([]).request("/v1/markets/NVDA/flow?days=9");
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "BAD_REQUEST" });
});

test("token flow for an unknown market returns 404", async () => {
  const response = await appWith([]).request("/v1/markets/NOPE/flow");
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: "NOT_FOUND", message: "Unknown market symbol: NOPE" });
});
