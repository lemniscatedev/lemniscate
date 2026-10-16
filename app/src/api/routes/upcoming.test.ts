import { expect, test } from "bun:test";
import pino from "pino";
import { testDeployment } from "../../indexer/test-support";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { TtlCache } from "../cache";
import { createApiApp } from "../app";
import type { ApiDependencies } from "../types";
import { buildSignedMessage, canonicalPayloadHash } from "../signed-action";

const origin = "https://app.example.test";

async function fixture(apiRateLimit = 0) {
  const subscriptions = new Set<string>();
  const nonces = new Set<string>();
  const calls: { query: string; values: unknown[] }[] = [];
  const execute = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    calls.push({ query, values });
    if (query.includes("group by upcoming_id")) {
      const count = [...subscriptions].filter((entry) => entry.startsWith("spcx:")).length;
      return count ? [{ upcoming_id: "spcx", n: count }] : [];
    }
    if (query.includes("select upcoming_id from upcoming_subscriptions where address =")) {
      return [...subscriptions].flatMap((entry) => entry.endsWith(`:${values[0]}`) ? [{ upcoming_id: entry.split(":")[0] }] : []);
    }
    if (query.includes("insert into upcoming_subscriptions")) {
      subscriptions.add(`${values[0]}:${values[1]}`);
      return [];
    }
    if (query.includes("delete from upcoming_subscriptions")) {
      subscriptions.delete(`${values[0]}:${values[1]}`);
      return [];
    }
    if (query.includes("count(*)::int as n")) {
      const count = [...subscriptions].filter((entry) => entry.startsWith(`${values[0]}:`)).length;
      return [{ n: count }];
    }
    if (query.includes("select 1 from upcoming_subscriptions")) {
      return subscriptions.has(`${values[0]}:${values[1]}`) ? [{ one: 1 }] : [];
    }
    return [];
  };
  const transaction = async (strings: TemplateStringsArray, ...values: unknown[]) => {
    const query = strings.join("?");
    calls.push({ query, values });
    if (query.includes("insert into api_nonces")) {
      const key = `${values[0]}:${values[1]}`;
      if (nonces.has(key)) return [];
      nonces.add(key);
      return [{ nonce: values[1] }];
    }
    return [];
  };
  const sql = Object.assign(execute, {
    begin: async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
  });
  const cache = new TtlCache();
  await cache.getOrLoad("markets:list", 3_000, async () => [{ symbol: "SPCX", launched: false }]);
  const app = createApiApp({
    sql,
    config: { CORS_ORIGINS: [origin], API_RATE_LIMIT_PER_MINUTE: apiRateLimit, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet" },
    deployment: testDeployment(), logger: pino({ level: "silent" }), cache,
  } as unknown as ApiDependencies);
  return { app, calls, subscriptions };
}

async function signedBody(
  action: string,
  id: string,
  nonce = Math.random().toString(36).slice(2).padEnd(24, "x"),
  account = privateKeyToAccount(generatePrivateKey()),
) {
  const address = account.address.toLowerCase();
  const issued = new Date(Date.now() - 1_000).toISOString();
  const expires = new Date(Date.now() + 5 * 60_000).toISOString();
  const fields = { action, address, payloadHash: canonicalPayloadHash({ id }), nonce, issued, expires };
  const signature = await account.signMessage({ message: buildSignedMessage(fields) });
  return { account, address, body: { address, nonce, issued, expires, signature } };
}

function writeRequest(method: "POST" | "DELETE", id: string, body: unknown) {
  return {
    method,
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  };
}

test("GET upcoming is public-cached without an address and private no-store with one", async () => {
  const { app, calls } = await fixture();
  const publicResponse = await app.request("/v1/upcoming");
  expect(publicResponse.status).toBe(200);
  expect(publicResponse.headers.get("cache-control")).toBe("public, max-age=15, stale-while-revalidate=60");
  expect((await publicResponse.json() as { items: unknown[] }).items).toHaveLength(10);
  await app.request("/v1/upcoming");
  expect(calls.filter((call) => call.query.includes("group by upcoming_id"))).toHaveLength(1);

  const address = "0x1111111111111111111111111111111111111111";
  const privateResponse = await app.request(`/v1/upcoming?address=${address}`);
  expect(privateResponse.status).toBe(200);
  expect(privateResponse.headers.get("cache-control")).toBe("private, no-store");
  expect(calls.filter((call) => call.query.includes("where address ="))).toHaveLength(1);
});

test("signed subscribe and unsubscribe update state without returning the signature", async () => {
  const { app, calls, subscriptions } = await fixture();
  const signed = await signedBody("upcoming.subscribe", "spcx", "abcdefghijklmnopqrstuvwx");
  const subscribed = await app.request("/v1/upcoming/spcx/subscribe", writeRequest("POST", "spcx", signed.body));
  expect(subscribed.status).toBe(200);
  expect(subscribed.headers.get("cache-control")).toBe("no-store");
  expect(await subscribed.json()).toEqual({ id: "spcx", interest: 1, subscribed: true });

  const privateList = await app.request(`/v1/upcoming?address=${signed.address}`);
  const privateBody = await privateList.json() as { items: Array<{ id: string; subscribed: boolean | null }> };
  expect(privateBody.items.find((item) => item.id === "spcx")?.subscribed).toBe(true);

  const replay = await app.request("/v1/upcoming/spcx/subscribe", writeRequest("POST", "spcx", signed.body));
  expect(replay.status).toBe(401);
  expect(await replay.json()).toEqual({ error: "UNAUTHORIZED", message: "Request already used." });

  const remove = await signedBody("upcoming.unsubscribe", "spcx", "zyxwvutsrqponmlkjihgfedc", signed.account);
  const unsubscribed = await app.request("/v1/upcoming/spcx/subscribe", writeRequest("DELETE", "spcx", remove.body));
  expect(unsubscribed.status).toBe(200);
  expect(calls.filter((call) => call.query.includes("delete from upcoming_subscriptions")).map((call) => call.values)).toEqual([["spcx", signed.address]]);
  expect([...subscriptions]).toEqual([]);
  expect(await unsubscribed.json()).toEqual({ id: "spcx", interest: 0, subscribed: false });
});

test("upcoming write routes reject unknown ids, malformed bodies and bad signatures", async () => {
  const { app } = await fixture();
  const signed = await signedBody("upcoming.subscribe", "missing");
  const unknown = await app.request("/v1/upcoming/missing/subscribe", writeRequest("POST", "missing", signed.body));
  expect(unknown.status).toBe(404);

  const malformed = await app.request("/v1/upcoming/spcx/subscribe", writeRequest("POST", "spcx", {}));
  expect(malformed.status).toBe(400);

  const missingBody = await app.request("/v1/upcoming/spcx/subscribe", {
    method: "POST",
    headers: { origin },
  });
  expect(missingBody.status).toBe(400);

  const invalidJson = await app.request("/v1/upcoming/spcx/subscribe", {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: "{",
  });
  expect(invalidJson.status).toBe(400);

  const bad = await signedBody("upcoming.subscribe", "spcx");
  const unauthorized = await app.request("/v1/upcoming/spcx/subscribe", writeRequest("POST", "spcx", {
    ...bad.body, signature: `0x${"0".repeat(130)}`,
  }));
  expect(unauthorized.status).toBe(401);
  expect(await unauthorized.json()).toEqual({ error: "UNAUTHORIZED", message: "Signature check failed." });
});

test("upcoming request bodies are capped at 4 KB and write requests are limited to 20 per minute", async () => {
  const { app } = await fixture();
  const oversized = await app.request("/v1/upcoming/spcx/subscribe", writeRequest("POST", "spcx", { data: "x".repeat(5_000) }));
  expect(oversized.status).toBe(413);
  expect(oversized.headers.get("cache-control")).toBe("no-store");

  const limited = await fixture(300);
  for (let request = 0; request < 20; request += 1) {
    expect((await limited.app.request("/v1/upcoming/spcx/subscribe", writeRequest("POST", "spcx", {}))).status).toBe(400);
  }
  const blocked = await limited.app.request("/v1/upcoming/spcx/subscribe", writeRequest("POST", "spcx", {}));
  expect(blocked.status).toBe(429);
});

test("upcoming write endpoints are included in CORS allowed methods", async () => {
  const { app } = await fixture();
  const response = await app.request("/v1/upcoming/spcx/subscribe", {
    method: "OPTIONS",
    headers: { origin, "access-control-request-method": "POST" },
  });
  expect(response.headers.get("access-control-allow-methods")).toContain("POST");
  expect(response.headers.get("access-control-allow-methods")).toContain("DELETE");
});
