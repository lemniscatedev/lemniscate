import {
  activityResponseSchema, candleSchema, carrySchema, configResponseSchema, corpActionsSchema,
  healthResponseSchema, marketDetailResponseSchema, marketListResponseSchema, portfolioResponseSchema,
  regimeListSchema, statsResponseSchema, tradeListSchema, vaultHistorySchema, vaultResponseSchema,
} from "../src/api/schemas";

const apiRoot = (process.argv[2] ?? process.env.API_URL ?? "http://127.0.0.1:7201").replace(/\/$/, "");
const address = process.env.SMOKE_ADDRESS ?? "0x000000000000000000000000000000000000cafe";
const checks: Array<{ path: string; schema?: { parse(value: unknown): unknown } }> = [
  { path: "/v1/health", schema: healthResponseSchema },
  { path: "/v1/config", schema: configResponseSchema },
  { path: "/v1/markets", schema: marketListResponseSchema },
  { path: "/v1/markets/NVDA", schema: marketDetailResponseSchema },
  { path: "/v1/markets/NVDA/candles?range=1H&series=price", schema: candleSchema },
  { path: "/v1/markets/NVDA/carry?range=1W", schema: carrySchema },
  { path: "/v1/markets/NVDA/trades?limit=10", schema: tradeListSchema },
  { path: "/v1/markets/NVDA/regimes?limit=10", schema: regimeListSchema },
  { path: `/v1/accounts/${address}/portfolio`, schema: portfolioResponseSchema },
  { path: `/v1/accounts/${address}/activity?type=all&limit=10`, schema: activityResponseSchema },
  { path: "/v1/vault", schema: vaultResponseSchema },
  { path: "/v1/vault/history?range=1W", schema: vaultHistorySchema },
  { path: "/v1/corporate-actions?symbol=NVDA", schema: corpActionsSchema },
  { path: "/v1/stats", schema: statsResponseSchema },
];

for (const check of checks) {
  const response = await fetch(`${apiRoot}${check.path}`);
  if (!response.ok) throw new Error(`${check.path} returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  check.schema?.parse(body);
}

const openapi = await fetch(`${apiRoot}/v1/openapi.json`);
if (!openapi.ok) throw new Error(`/v1/openapi.json returned HTTP ${openapi.status}`);
const document = await openapi.json() as { openapi?: unknown; paths?: Record<string, unknown> };
if (document.openapi !== "3.1.0") throw new Error("OpenAPI document is not version 3.1.0");
for (const path of [
  "/v1/health", "/v1/config", "/v1/markets", "/v1/markets/{symbol}", "/v1/markets/{symbol}/candles",
  "/v1/markets/{symbol}/carry", "/v1/markets/{symbol}/trades", "/v1/markets/{symbol}/regimes",
  "/v1/accounts/{address}/portfolio", "/v1/accounts/{address}/activity", "/v1/vault", "/v1/vault/history",
  "/v1/corporate-actions", "/v1/stats",
]) {
  const pathItem = document.paths?.[path] as { get?: { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> } } | undefined;
  const responseSchema = pathItem?.get?.responses?.["200"]?.content?.["application/json"]?.schema;
  if (!responseSchema) throw new Error(`OpenAPI is missing a 200 response schema for ${path}`);
}
const documentPath = document.paths?.["/v1/openapi.json"];
if (documentPath) throw new Error("OpenAPI document must not list itself as an API operation.");
console.info(`API smoke passed: ${checks.length + 1} endpoints validated.`);
