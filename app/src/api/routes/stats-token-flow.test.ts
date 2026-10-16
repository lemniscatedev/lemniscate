import { expect, test } from "bun:test";
import pino from "pino";
import { createApiApp } from "../app";
import { TtlCache } from "../cache";
import type { ApiDependencies } from "../types";

test("hottest token flow rejects limits above twenty", async () => {
  const app = createApiApp({
    sql: async () => [],
    config: { CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet" },
    deployment: { contracts: { engine: "0x1111111111111111111111111111111111111111", vault: "0x2222222222222222222222222222222222222222" } },
    logger: pino({ level: "silent" }),
    cache: new TtlCache(),
  } as unknown as ApiDependencies);
  const response = await app.request("/v1/stats/token-flow?limit=50");
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ error: "BAD_REQUEST" });
});
