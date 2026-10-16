import {
  chainListSchema, chainResponseSchema, configResponseSchema, intentResponseSchema, poolResponseSchema,
  positionsResponseSchema, quoteResponseSchema, seriesResponseSchema, volResponseSchema,
} from "../src/api/option-schemas";
import { activityResponseSchema, agentsResponseSchema, smartAccountResponseSchema } from "../src/api/option-schemas";
import { healthResponseSchema } from "../src/api/schemas";

const apiRoot = (process.argv[2] ?? process.env.API_URL ?? "http://127.0.0.1:3101").replace(/\/$/, "");
const name = (process.env.SMOKE_NAME ?? "NVDA").toUpperCase();
const address = process.env.SMOKE_ADDRESS ?? "0x000000000000000000000000000000000000cafe";

type Schema = { parse(value: unknown): unknown };
async function call(path: string, schema: Schema, init?: RequestInit): Promise<unknown> {
  const response = await fetch(`${apiRoot}${path}`, init);
  if (!response.ok) throw new Error(`${init?.method ?? "GET"} ${path} returned HTTP ${response.status}`);
  const body: unknown = await response.json();
  schema.parse(body);
  return body;
}
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

let checked = 0;
await call("/v1/health", healthResponseSchema); checked++;
const config = await call("/v1/config", configResponseSchema) as { names: string[] }; checked++;
if (!config.names.includes(name)) throw new Error(`/v1/config does not list ${name}`);
await call("/v1/chains", chainListSchema); checked++;
const chain = await call(`/v1/chains/${name}`, chainResponseSchema) as {
  speeds: { strikes: { call: { id: string; buyable: boolean } | null; put: { id: string } | null }[] }[];
}; checked++;
const firstCall = chain.speeds.flatMap((s) => s.strikes).flatMap((row) => (row.call ? [row.call] : []))[0];
if (!firstCall) throw new Error(`${name} has no listed call to quote`);
await call(`/v1/series/${firstCall.id}`, seriesResponseSchema); checked++;
await call("/v1/quote", quoteResponseSchema, post({ series: firstCall.id, units: "1", side: "buy" })); checked++;
// Intents: a sell always answers; a buy answers 200 when buys are open and 409 with a reason when they are not.
await call("/v1/intent/sell", intentResponseSchema, post({ series: firstCall.id, units: "1", account: address })); checked++;
const buy = await fetch(`${apiRoot}/v1/intent/buy`, post({ series: firstCall.id, units: "1", account: address }));
if (buy.status === 200) intentResponseSchema.parse(await buy.json());
else if (buy.status !== 409) throw new Error(`POST /v1/intent/buy returned HTTP ${buy.status}`);
checked++;
const shield = await fetch(`${apiRoot}/v1/intent/shield`, post({ name, tokenUnits: "1", account: address }));
if (shield.status === 200) intentResponseSchema.parse(await shield.json());
else if (shield.status !== 409) throw new Error(`POST /v1/intent/shield returned HTTP ${shield.status}`);
checked++;
await call("/v1/pool", poolResponseSchema); checked++;
await call(`/v1/vol/${name}`, volResponseSchema); checked++;
await call(`/v1/accounts/${address}/positions`, positionsResponseSchema); checked++;
await call(`/v1/accounts/${address}/activity?limit=5`, activityResponseSchema); checked++;
await call(`/v1/accounts/${address}/agents`, agentsResponseSchema); checked++;
await call(`/v1/accounts/${address}/smart-account`, smartAccountResponseSchema); checked++;

const openapi = await fetch(`${apiRoot}/v1/openapi.json`);
if (!openapi.ok) throw new Error(`/v1/openapi.json returned HTTP ${openapi.status}`);
const document = await openapi.json() as { openapi?: unknown; paths?: Record<string, Record<string, unknown>> };
if (document.openapi !== "3.1.0") throw new Error("OpenAPI document is not version 3.1.0");
for (const [path, method] of [
  ["/v1/health", "get"], ["/v1/config", "get"], ["/v1/chains", "get"], ["/v1/chains/{name}", "get"], ["/v1/series/{id}", "get"],
  ["/v1/quote", "post"], ["/v1/intent/buy", "post"], ["/v1/intent/sell", "post"], ["/v1/intent/shield", "post"],
  ["/v1/pool", "get"], ["/v1/vol/{name}", "get"], ["/v1/accounts/{address}/positions", "get"],
  ["/v1/accounts/{address}/activity", "get"], ["/v1/accounts/{address}/agents", "get"], ["/v1/accounts/{address}/smart-account", "get"],
] as const) {
  const operation = document.paths?.[path]?.[method] as { responses?: Record<string, { content?: Record<string, { schema?: unknown }> }> } | undefined;
  if (!operation?.responses?.["200"]?.content?.["application/json"]?.schema) throw new Error(`OpenAPI is missing a 200 response schema for ${method} ${path}`);
}
if (document.paths?.["/v1/openapi.json"]) throw new Error("OpenAPI document must not list itself as an API operation.");
console.info(`API smoke passed: ${checked + 1} endpoints validated.`);
