import { describe, expect, test } from "bun:test";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { decodeFunctionData, encodeFunctionData, recoverMessageAddress, type Hex } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { pino } from "pino";
import { OptionEngineAbi } from "../../abi";
import { kernelAbi } from "../../aa/kernel";
import { ACCOUNT, ENGINE, OWNER, SIGNER_KEY, USDG, createTestServices } from "../../aa/test-support";
import { createApiApp } from "../app";
import { TtlCache } from "../cache";
import { registerIntentUserOp } from "./intent-userop";
import type { ApiDependencies } from "../types";

const SERIES = `0x${"a0".repeat(32)}`;
const owner = privateKeyToAccount(SIGNER_KEY); // any key works as the test "user"; the server never sees it

function intentFixture(kind: "buy" | "sell" | "shield") {
  const data = encodeFunctionData({
    abi: OptionEngineAbi, functionName: "buy", args: [SERIES as Hex, 10n ** 18n, 5_000_000n, 1_800_000_000n, ACCOUNT],
  });
  return {
    kind, to: ENGINE, data, value: "0",
    approvals: kind === "sell" ? [] : [{ token: USDG, spender: ENGINE, amount: "5000000" }],
    maxCostUsdg: "5000000", deadline: 1_800_000_000, series: SERIES, queued: false, note: null,
  };
}

function makeApp(options: Parameters<typeof createTestServices>[0] = {}) {
  const test_ = createTestServices(options);
  const deps = {
    sql: {} as never,
    config: { API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", RPC_URL_OVERRIDE: "", PUBLIC_RPC_URL: "http://rpc.invalid" },
    deployment: { contracts: { engine: ENGINE, usdg: USDG } },
    logger: pino({ level: "silent" }),
    cache: new TtlCache(),
    aa: test_.services,
    // These tests are about the format; the sponsorship policy has its own tests (api/sponsorship.test.ts).
    sponsorship: { evaluate: async () => ({ granted: true as const, ticket: 1 }), release: async () => undefined },
  } as unknown as ApiDependencies;
  const app = new OpenAPIHono();
  registerIntentUserOp(app, deps);
  // A stand-in for the real intent routes (same zod-openapi plumbing, same URL shape).
  const body = z.object({ account: z.string(), series: z.string().optional(), units: z.string().optional() });
  for (const kind of ["buy", "sell", "shield"] as const) {
    app.openapi(
      createRoute({
        method: "post", path: `/v1/intent/${kind}`,
        request: { body: { required: true, content: { "application/json": { schema: body } } } },
        responses: { 200: { description: "ok", content: { "application/json": { schema: z.any() } } }, 409: { description: "blocked", content: { "application/json": { schema: z.any() } } } },
      }),
      (context) => {
        const input = context.req.valid("json");
        if (input.units === "blocked") return context.json({ error: "BUY_BLOCKED", message: "closed", reason: "SESSION_CLOSED" }, 409);
        return context.json(intentFixture(kind), 200);
      },
    );
  }
  return { app, ...test_ };
}

const post = (app: OpenAPIHono, path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

describe("intentUserOpFormat (R2)", () => {
  test("format omitted: the plain intent comes back untouched (R6 fallback)", async () => {
    const { app } = makeApp();
    const response = await post(app, "/v1/intent/buy", { account: ACCOUNT });
    expect(response.status).toBe(200);
    const json = await response.json() as Record<string, unknown>;
    expect(json.kind).toBe("buy");
    expect(json.userOp).toBeUndefined();
    expect(json.to).toBe(ENGINE);
  });

  test("format=userop returns the unsigned operation, its hash, signing instructions and the plain fallback", async () => {
    const { app } = makeApp();
    const response = await post(app, "/v1/intent/buy?format=userop", { account: ACCOUNT });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const json = await response.json() as Record<string, any>;
    expect(json.format).toBe("userop");
    expect(json.kind).toBe("buy");
    expect(json.userOp.sender.toLowerCase()).toBe(ACCOUNT);
    expect(json.userOp.signature).toBe("0x");
    expect(json.userOpHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(json.signing.message).toBe(json.userOpHash);
    expect(json.sponsored).toBe(true);
    expect(json.userOp.callGasLimit).toMatch(/^0x/);
    // [approve USDG to the engine, engine.buy] as one execute()
    const decoded = decodeFunctionData({ abi: kernelAbi, data: json.userOp.callData });
    expect((decoded.args as [Hex, Hex])[0].startsWith("0x01")).toBe(true);
    expect(json.calls).toHaveLength(2);
    expect(json.calls[0].to).toBe(USDG);
    expect(json.calls[1].to).toBe(ENGINE);
    // The plain transaction for the same action rides along.
    expect(json.fallback.to).toBe(ENGINE);
    expect(json.fallback.approvals).toHaveLength(1);
  });

  test("sell and shield work the same way; sell needs no approval", async () => {
    const { app } = makeApp();
    const sell = await (await post(app, "/v1/intent/sell?format=userop", { account: ACCOUNT })).json() as Record<string, any>;
    expect(sell.calls).toHaveLength(1);
    const shield = await (await post(app, "/v1/intent/shield?format=userop", { account: ACCOUNT })).json() as Record<string, any>;
    expect(shield.calls).toHaveLength(2);
  });

  test("the owner signs the hash and the relay forwards the signed operation to the bundler", async () => {
    const { app, mock } = makeApp();
    const built = await (await post(app, "/v1/intent/buy?format=userop", { account: ACCOUNT })).json() as Record<string, any>;
    const signature = await owner.signMessage({ message: { raw: built.userOpHash } });
    expect(await recoverMessageAddress({ message: { raw: built.userOpHash }, signature })).toBe(owner.address);
    const sent = await post(app, "/v1/userop/send", { userOp: { ...built.userOp, signature } });
    expect(sent.status).toBe(200);
    const result = await sent.json() as Record<string, string>;
    expect(result.userOpHash).toBe(built.userOpHash);
    expect(mock.sent).toHaveLength(1);
    expect(mock.sent[0]!.op.signature).toBe(signature);
    expect(mock.sent[0]!.op.callData).toBe(built.userOp.callData);
    expect(mock.sent[0]!.hash).toBe(built.userOpHash);
    // Receipt lookups
    const receipt = await (await app.request(`/v1/userop/${result.userOpHash}`)).json() as Record<string, any>;
    expect(receipt.status).toBe("included");
    const pending = await (await app.request(`/v1/userop/0x${"cd".repeat(32)}`)).json() as Record<string, any>;
    expect(pending.status).toBe("pending");
  });

  test("relay rejects missing or malformed signatures before touching the bundler", async () => {
    const { app, mock } = makeApp();
    const built = await (await post(app, "/v1/intent/buy?format=userop", { account: ACCOUNT })).json() as Record<string, any>;
    expect((await post(app, "/v1/userop/send", { userOp: built.userOp })).status).toBe(400);
    expect((await post(app, "/v1/userop/send", { userOp: { ...built.userOp, signature: "0x1234" } })).status).toBe(400);
    expect((await post(app, "/v1/userop/send", { nope: true })).status).toBe(400);
    expect((await app.request("/v1/userop/not-a-hash")).status).toBe(400);
    expect(mock.sent).toHaveLength(0);
  });

  test("bundler rejections come back as 502 BUNDLER_ERROR", async () => {
    const { app } = makeApp({ bundler: { failSend: "AA21 didn't pay prefund" } });
    const built = await (await post(app, "/v1/intent/buy?format=userop", { account: ACCOUNT })).json() as Record<string, any>;
    const signature = await owner.signMessage({ message: { raw: built.userOpHash } });
    const sent = await post(app, "/v1/userop/send", { userOp: { ...built.userOp, signature } });
    expect(sent.status).toBe(502);
    expect(await sent.json()).toMatchObject({ error: "BUNDLER_ERROR", message: "AA21 didn't pay prefund" });
  });

  test("a new account needs `owner`; with it the operation deploys the account", async () => {
    const { app, state } = makeApp();
    state.deployed.clear();
    const missing = await post(app, "/v1/intent/buy?format=userop", { account: ACCOUNT });
    expect(missing.status).toBe(422);
    expect(await missing.json()).toMatchObject({ error: "OWNER_REQUIRED" });
    const ok = await (await post(app, "/v1/intent/buy?format=userop", { account: ACCOUNT, owner: OWNER })).json() as Record<string, any>;
    expect(ok.deploysAccount).toBe(true);
    expect(ok.userOp.factory).toBeDefined();
  });

  test("sponsor:false asks the account to pay its own gas", async () => {
    const { app } = makeApp();
    const json = await (await post(app, "/v1/intent/buy?format=userop", { account: ACCOUNT, sponsor: false })).json() as Record<string, any>;
    expect(json.sponsored).toBe(false);
    expect(json.userOp.paymaster).toBeUndefined();
  });

  test("errors from the intent route pass through unchanged", async () => {
    const { app } = makeApp();
    const blocked = await post(app, "/v1/intent/buy?format=userop", { account: ACCOUNT, units: "blocked" });
    expect(blocked.status).toBe(409);
    expect(await blocked.json()).toMatchObject({ error: "BUY_BLOCKED", reason: "SESSION_CLOSED" });
    const bad = await post(app, "/v1/intent/buy?format=userop", { nope: 1 });
    expect(bad.status).toBe(400);
  });

  test("chain trouble is a 503 and the plain transaction still works", async () => {
    const { app, state } = makeApp();
    state.down = true;
    const response = await post(app, "/v1/intent/buy?format=userop", { account: ACCOUNT });
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ error: "CHAIN_UNAVAILABLE" });
    expect((await post(app, "/v1/intent/buy", { account: ACCOUNT })).status).toBe(200);
  });

  test("config endpoint describes the setup without secrets", async () => {
    const { app } = makeApp();
    const text = await (await app.request("/v1/userop/config")).text();
    expect(text).toContain("entryPoint");
    expect(text).toContain("0x0000000071727de22e5e9d8baf0edac6f37da032".slice(0, 12));
    expect(text).not.toContain(SIGNER_KEY.slice(2));
    expect(JSON.parse(text)).toMatchObject({ chainId: 4663, kernelVersion: "3.3", sponsoring: true });
  });

  test("with nothing configured the userop path says so and the plain path keeps working", async () => {
    const deps = {
      sql: {} as never, config: { API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", RPC_URL_OVERRIDE: "", PUBLIC_RPC_URL: "http://rpc.invalid" },
      deployment: { contracts: { engine: ENGINE, usdg: USDG } }, logger: pino({ level: "silent" }), cache: new TtlCache(),
    } as unknown as ApiDependencies;
    const saved = { ...process.env };
    process.env.PAYMASTER_ADDRESS = "0x2222222222222222222222222222222222222222"; // address without a key: misconfigured
    delete process.env.PAYMASTER_SIGNER_KEY;
    try {
      const app = new OpenAPIHono();
      registerIntentUserOp(app, deps);
      app.post("/v1/intent/buy", (context) => context.json(intentFixture("buy")));
      const response = await app.request("/v1/intent/buy?format=userop", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ account: ACCOUNT }) });
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({ error: "AA_UNAVAILABLE" });
      expect((await app.request("/v1/intent/buy", { method: "POST" })).status).toBe(200);
    } finally {
      for (const key of ["PAYMASTER_ADDRESS", "PAYMASTER_SIGNER_KEY"]) {
        if (saved[key] === undefined) delete process.env[key]; else process.env[key] = saved[key];
      }
    }
  });
});

describe("wiring", () => {
  test("the production app registers the userop routes", async () => {
    const deps = {
      sql: {} as never,
      config: { CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", RPC_URL_OVERRIDE: "", PUBLIC_RPC_URL: "http://rpc.invalid", NETWORK: "mainnet" },
      deployment: { contracts: { engine: ENGINE, usdg: USDG }, stocks: [] },
      logger: pino({ level: "silent" }), cache: new TtlCache(),
    } as unknown as ApiDependencies;
    const app = createApiApp(deps);
    const response = await app.request("/v1/userop/not-a-hash");
    expect(response.status).toBe(400);
  });
});
