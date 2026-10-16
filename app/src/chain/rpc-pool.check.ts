import { strict as assert } from "node:assert";
import { loadConfig } from "../config";
import { RpcPool, type RpcEndpointInfo } from "./rpc-pool";

function testConfig() {
  return loadConfig({
    NODE_ENV: "test",
    NETWORK: "fork",
    CHAIN_ID: "4663",
    DATABASE_URL: "postgres://lemniscate:dev-only@localhost:7232/lemniscate",
    POSTGRES_PASSWORD: "dev-only",
    ALCHEMY_API_KEYS: "test-key-one,test-key-two",
    ALCHEMY_URL_TEMPLATE: "https://alchemy.invalid/v2/{key}",
    PUBLIC_RPC_URL: "https://public.invalid",
    RPC_ROUTE_LOGS: "public,alchemy",
    RPC_ROUTE_STATE: "public,alchemy",
    RPC_ROUTE_TX: "alchemy,public",
  });
}

function transientFailure(): Error & { status: number } {
  return Object.assign(new Error("HTTP request failed with status 503"), { status: 503 });
}

const routingCalls: string[] = [];
const stablePool = new RpcPool(testConfig(), {
  requestFactory: (endpoint: RpcEndpointInfo) => async ({ method }) => {
    routingCalls.push(`${endpoint.id}:${method}`);
    if (method === "eth_chainId") return "0x1237";
    if (method === "eth_getBalance") return "0xde0b6b3a7640000";
    throw new Error(`Unexpected test RPC method ${method}`);
  },
});

assert.equal(await stablePool.request("state", { method: "eth_chainId" }), "0x1237");
const identicalRequests = await Promise.all(
  Array.from({ length: 10 }, () =>
    stablePool.request("state", {
      method: "eth_getBalance",
      params: ["0x0000000000000000000000000000000000000001", "latest"],
    }),
  ),
);
assert.equal(new Set(identicalRequests).size, 1);
assert.equal(routingCalls.filter((call) => call.endsWith(":eth_getBalance")).length, 1);
assert.equal(await stablePool.request("state", { method: "eth_chainId" }), "0x1237");
assert.equal(routingCalls.filter((call) => call.endsWith(":eth_chainId")).length, 1);
assert.equal(routingCalls[0], "public:eth_chainId");

const batchCalls: string[] = [];
const batchPool = new RpcPool(testConfig(), {
  requestFactory: (endpoint: RpcEndpointInfo) => async ({ method, params }) => {
    batchCalls.push(`${endpoint.id}:${method}:${String(params?.[0] ?? "")}`);
    return method === "eth_getLogs" ? [{ address: params?.[0] }] : null;
  },
});
const batchResult = await batchPool.requestBatch("logs", [
  { method: "eth_getLogs", params: [{ address: ["0x1"], fromBlock: "0x1", toBlock: "0x2" }] },
  { method: "eth_getLogs", params: [{ address: ["0x2"], fromBlock: "0x1", toBlock: "0x2" }] },
]);
assert.deepEqual(batchResult, [[{ address: { address: ["0x1"], fromBlock: "0x1", toBlock: "0x2" } }], [{ address: { address: ["0x2"], fromBlock: "0x1", toBlock: "0x2" } }]]);
assert.deepEqual(batchCalls.map((call) => call.split(":")[0]), ["public", "public"]);
assert.equal(batchPool.stats().classes.logs.requests, 2);
assert.equal(batchPool.stats().classes.logs.estimatedCu, 150);

const httpBatches: { url: string; payload: unknown }[] = [];
const mockFetch = Object.assign(
  async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const payload: unknown = JSON.parse(String(init?.body));
    httpBatches.push({ url: String(input), payload });
    const requests = payload as { id: number; method: string; params?: unknown[] }[];
    return new Response(
      JSON.stringify(
        requests.map((request) => ({
          jsonrpc: "2.0",
          id: request.id,
          result: { method: request.method, filter: request.params?.[0] },
        })),
      ),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  },
  { preconnect: async (_url: string | URL) => undefined },
) as typeof fetch;
const httpBatchPool = new RpcPool(testConfig(), {
  fetchFn: mockFetch,
});
const httpBatchResult = await httpBatchPool.requestBatch("logs", [
  { method: "eth_getLogs", params: [{ address: ["0x1"], fromBlock: "0x1", toBlock: "0x2" }] },
  { method: "eth_getLogs", params: [{ address: ["0x2"], fromBlock: "0x1", toBlock: "0x2" }] },
]);
assert.equal(httpBatches.length, 1, "requestBatch must issue one HTTP JSON-RPC batch");
assert.equal(httpBatches[0]?.url, "https://public.invalid/");
assert.deepEqual(
  (httpBatches[0]?.payload as { method: string }[]).map((request) => request.method),
  ["eth_getLogs", "eth_getLogs"],
);
assert.deepEqual(
  httpBatchResult.map((result) => (result as { filter: { address: string[] } }).filter.address),
  [["0x1"], ["0x2"]],
);

let fakeNow = 1_000;
let latestCodeReads = 0;
const latestCodePool = new RpcPool(testConfig(), {
  now: () => fakeNow,
  requestFactory: () => async () => {
    latestCodeReads += 1;
    return "0x";
  },
});
const codeRequest = {
  method: "eth_getCode",
  params: ["0x0000000000000000000000000000000000000001", "latest"],
} as const;
await latestCodePool.request("state", codeRequest);
await latestCodePool.request("state", codeRequest);
assert.equal(latestCodeReads, 1);
fakeNow += 1_001;
await latestCodePool.request("state", codeRequest);
assert.equal(latestCodeReads, 2);

const failoverCalls: string[] = [];
const failoverPool = new RpcPool(testConfig(), {
  requestFactory: (endpoint: RpcEndpointInfo) => async ({ method }) => {
    failoverCalls.push(`${endpoint.id}:${method}`);
    if (endpoint.id === "public" || endpoint.id === "alchemy#1") throw transientFailure();
    return "0x1";
  },
});

assert.equal(
  await failoverPool.request("state", { method: "eth_getBalance", params: ["0x1", "latest"] }),
  "0x1",
);
assert.deepEqual(
  failoverCalls.map((call) => call.split(":")[0]),
  ["public", "alchemy#1", "alchemy#2"],
);

const unsafeErrorPool = new RpcPool(testConfig(), {
  requestFactory: (endpoint: RpcEndpointInfo) => async () => {
    const revert = Object.assign(new Error("execution reverted"), {
      code: 3,
      data: "0x08c379a0",
    });
    const providerError = Object.assign(
      new Error(`Provider rejected request at ${endpoint.url}`),
      { cause: revert },
    );
    throw providerError;
  },
});
let surfacedError: unknown;
try {
  await unsafeErrorPool.request("tx", { method: "eth_getBalance", params: ["0x1", "latest"] });
} catch (error) {
  surfacedError = error;
}
assert.ok(surfacedError instanceof Error);
assert.equal(surfacedError.message.includes("test-key-one"), false);
assert.equal(surfacedError.message.includes("test-key-two"), false);
assert.equal(surfacedError.message.includes("https://"), false);
assert.equal((surfacedError as Error & { code?: number }).code, 3);
assert.equal((surfacedError as Error & { data?: string }).data, "0x08c379a0");
assert.equal("cause" in surfacedError, false);
const serializedError = JSON.stringify({
  name: surfacedError.name,
  message: surfacedError.message,
  code: (surfacedError as Error & { code?: number }).code,
  data: (surfacedError as Error & { data?: string }).data,
});
assert.equal(serializedError.includes("test-key-one"), false);
assert.equal(serializedError.includes("test-key-two"), false);

console.info(
  "RPC pool checks passed: public-first routing, batched request accounting, Alchemy key rotation, single-flight, chainId/code caching, and sanitized revert data.",
);
