import { expect, test } from "bun:test";
import pino from "pino";
import { createApiApp } from "../app";
import { TtlCache } from "../cache";
import type { ApiDependencies } from "../types";

const address = "0x1111111111111111111111111111111111111111";

function appWith(queries: string[]) {
  const sql = async (strings: TemplateStringsArray) => { queries.push(strings.join("?")); return []; };
  return createApiApp({
    sql,
    config: { CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet" },
    deployment: {},
    logger: pino({ level: "silent" }),
    cache: new TtlCache(),
  } as unknown as ApiDependencies);
}

test("wallet stats are served privately and cached per address", async () => {
  const queries: string[] = [];
  const app = appWith(queries);
  const response = await app.request(`/v1/accounts/${address.toUpperCase().replace("0X", "0x")}/stats`);
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("private, max-age=15");
  expect(await response.json()).toMatchObject({ trades: 0, realizedPnlUsd: "0", winRatePct: null, markets: [], historyComplete: true });
  const count = queries.length;
  expect((await app.request(`/v1/accounts/${address}/stats`)).status).toBe(200);
  expect(queries).toHaveLength(count);
});

test("wallet stats reject an invalid address", async () => {
  expect((await appWith([]).request("/v1/accounts/nope/stats")).status).toBe(400);
});
