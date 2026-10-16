import { expect, test } from "bun:test";
import pino from "pino";
import { createApiApp } from "../app";
import { TtlCache } from "../cache";
import type { ApiDependencies } from "../types";

const address = "0x1111111111111111111111111111111111111111";

function appWith(rows: unknown[] = []) {
  const sql = async () => [];
  Object.assign(sql, { unsafe: async () => rows });
  return createApiApp({
    sql,
    config: { CORS_ORIGINS: ["http://localhost:7200"], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet" },
    deployment: {},
    logger: pino({ level: "silent" }),
    cache: new TtlCache(),
  } as unknown as ApiDependencies);
}

test("export rejects a reversed date range", async () => {
  expect((await appWith().request(`/v1/accounts/${address}/export.csv?from=2026-02-01&to=2026-01-01`)).status).toBe(400);
});

test("export rejects an impossible date", async () => {
  expect((await appWith().request(`/v1/accounts/${address}/export.csv?from=2026-13-01`)).status).toBe(400);
});

test("export rejects an invalid address", async () => {
  expect((await appWith().request("/v1/accounts/nope/export.csv")).status).toBe(400);
});

test("export downloads csv with history headers", async () => {
  const response = await appWith([
    { kind: "buy", symbol: "NVDA", usdg: "10", tokens: "2", price: "5", fee: "0.03", ts: "2026-01-15T00:00:00.000Z", tx_hash: `0x${"a".repeat(64)}`, log_index: 1 },
  ]).request(`/v1/accounts/${address}/export.csv?type=trades&from=2026-01-01&to=2026-01-31`);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toBe("text/csv; charset=utf-8");
  expect(response.headers.get("content-disposition")).toBe('attachment; filename="lemniscate-111111-2026-01-01-2026-01-31.csv"');
  expect(response.headers.get("cache-control")).toBe("private, no-store");
  expect(response.headers.get("x-lemniscate-history-complete")).toBe("true");
  expect(response.headers.get("x-lemniscate-truncated")).toBe("false");
  const body = new TextDecoder("utf-8", { ignoreBOM: true }).decode(await response.arrayBuffer());
  expect(body.startsWith("﻿\"Date (UTC)\"")).toBe(true);
  expect(body.split("\r\n")).toHaveLength(3);
});

test("export headers are exposed to allowed origins", async () => {
  const response = await appWith().request(`/v1/accounts/${address}/export.csv`, { headers: { Origin: "http://localhost:7200" } });
  expect(response.headers.get("access-control-allow-origin")).toBe("http://localhost:7200");
  expect(response.headers.get("access-control-expose-headers")).toContain("X-Lemniscate-Truncated");
});
