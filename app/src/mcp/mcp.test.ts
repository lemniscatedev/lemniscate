import { describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeFunctionData, getAddress, type Address, type Hex } from "viem";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
import { AgentRouterAbi, OptionEngineAbi } from "../abi";
import { ToolError, type ApiClient } from "./api-client";
import { buildMcp, createMcpHttpApp, TOOL_NAMES, toolListing } from "./index";
import { loadMcpSettings } from "./config";
import { runStdio } from "./stdio";
import type { ChainReader, Executor } from "./agent";

const SERIES = `0x${"a0".repeat(32)}` as Hex;
const OWNER = getAddress("0x00000000000000000000000000000000000000c3");
const ROUTER = getAddress("0x00000000000000000000000000000000000000f1");
const NVDA = getAddress("0x0000000000000000000000000000000000000a01");
const TSLA = getAddress("0x0000000000000000000000000000000000000a02");
const NOW_MS = 1_792_200_000_000;
const AGENT_KEY = generatePrivateKey();
const agentAddress = privateKeyToAccount(AGENT_KEY).address;

const policy = (over: Record<string, unknown> = {}) => JSON.stringify({
  owner: OWNER, budgetUsdg: "50000000", spentUsdg: "0", maxPerTradeUsdg: "20000000", expiresAt: Math.floor(NOW_MS / 1000) + 3600,
  canSell: true, canShield: true, revoked: false, stocks: [NVDA], ...over,
});

const quoteBody = { usdg: "4000000", feeUsdg: "1000" };
function fakeApi(log: Array<[string, unknown?]> = [], over: Record<string, () => unknown> = {}): ApiClient {
  const answer = (path: string, body?: unknown): unknown => {
    log.push([path, body]);
    const hit = Object.entries(over).find(([prefix]) => path.startsWith(prefix));
    if (hit) return hit[1]();
    if (path === "/v1/chains") return { names: ["NVDA", "TSLA"] };
    if (path.startsWith("/v1/chains/")) return { name: "NVDA", speeds: [{ speed: "DAILY", strikes: [] }, { speed: "WEEKLY", strikes: [] }] };
    if (path === "/v1/quote") return { series: SERIES, side: "buy", quote: quoteBody };
    if (path === "/v1/pool") return { navUsdg: "1000000" };
    if (path.startsWith("/v1/accounts/")) return { account: OWNER, positions: [] };
    if (path === "/v1/config") return { contracts: { agentRouter: ROUTER } };
    if (path.startsWith("/v1/series/")) return { id: SERIES, stock: NVDA };
    const b = body as { units?: string; tokenUnits?: string };
    if (path === "/v1/intent/buy") {
      return {
        kind: "buy", to: "0x00000000000000000000000000000000000000e1", value: "0", approvals: [], queued: false, note: null, series: SERIES,
        deadline: Math.floor(NOW_MS / 1000) + 300, maxCostUsdg: "4020000", quote: quoteBody,
        data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [SERIES, 10n ** 18n, 4_020_000n, BigInt(Math.floor(NOW_MS / 1000) + 300), OWNER] }),
      };
    }
    if (path === "/v1/intent/sell") {
      return {
        kind: "sell", to: "0x00000000000000000000000000000000000000e1", value: "0", approvals: [], queued: false, note: null, series: SERIES,
        deadline: Math.floor(NOW_MS / 1000) + 300, minProceedsUsdg: "3900000", tokens: (10n ** 18n).toString(), quote: quoteBody,
        data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "sell", args: [SERIES, 10n ** 18n, 3_900_000n, BigInt(Math.floor(NOW_MS / 1000) + 300), OWNER] }),
      };
    }
    if (path === "/v1/intent/shield") {
      return {
        kind: "shield", to: "0x00000000000000000000000000000000000000e1", value: "0", approvals: [], queued: false, note: null, series: SERIES,
        deadline: Math.floor(NOW_MS / 1000) + 300, maxCostUsdg: "5000000", quote: { usdg: "4800000" },
        data: encodeFunctionData({ abi: OptionEngineAbi, functionName: "shield", args: [NVDA, BigInt(b.tokenUnits ? 10n ** 18n : 1n), 1000, 5_000_000n, BigInt(Math.floor(NOW_MS / 1000) + 300)] }),
      };
    }
    throw new ToolError("NOT_FOUND", `no fake for ${path}`);
  };
  return { get: async (p) => answer(p), post: async (p, b) => answer(p, b) };
}

function setup(env: Record<string, string> = {}, api: ApiClient = fakeApi(), executor?: Executor, chain?: ChainReader) {
  const sent: Array<{ to: Address; data: Hex }> = [];
  const mockExecutor: Executor = executor ?? { send: async (c) => { sent.push(c); return { txHash: `0x${"ee".repeat(32)}` as Hex }; } };
  const settings = loadMcpSettings({ AGENT_ROUTER: ROUTER, AGENT_OWNER: OWNER, ...(env.AGENT_POLICY ? { AGENT_POLICY_FROM_ENV: "1" } : {}), ...env });
  const built = buildMcp(settings, { api, executor: mockExecutor, now: () => NOW_MS, ...(chain ? { chain } : {}) });
  return { ...built, sent, settings };
}

let seq = 0;
const rpc = (server: ReturnType<typeof setup>["server"], method: string, params?: unknown, key = "k") =>
  server.handle({ jsonrpc: "2.0", id: ++seq, method, ...(params === undefined ? {} : { params }) }, key);
const call = async (s: ReturnType<typeof setup>, name: string, args: unknown, key = "k") => {
  const response = await rpc(s.server, "tools/call", { name, arguments: args }, key);
  return response!.result as { isError: boolean; structuredContent: Record<string, any>; content: Array<{ text: string }> };
};

describe("R1 mcpToolsListAndSchema", () => {
  test("lists exactly the seven tools, each with a JSON schema", async () => {
    const s = setup();
    const response = await rpc(s.server, "tools/list");
    const tools = (response!.result as { tools: Array<{ name: string; description: string; inputSchema: any; annotations: any }> }).tools;
    expect(tools.map((t) => t.name).sort()).toEqual(["lmns_buy", "lmns_chain", "lmns_pool", "lmns_positions", "lmns_quote", "lmns_sell", "lmns_shield"]);
    for (const tool of tools) {
      expect(tool.description.length).toBeGreaterThan(20);
      expect(tool.inputSchema.type).toBe("object");
      expect(tool.inputSchema.additionalProperties).toBe(false);
    }
    expect(tools.find((t) => t.name === "lmns_quote")!.inputSchema.required.sort()).toEqual(["series", "side", "units"]);
    expect(tools.find((t) => t.name === "lmns_buy")!.annotations.readOnlyHint).toBe(false);
    expect(tools.find((t) => t.name === "lmns_pool")!.annotations.readOnlyHint).toBe(true);
    expect(TOOL_NAMES).toHaveLength(7);
  });

  test("initialize negotiates the protocol version and advertises tools", async () => {
    const s = setup();
    const ok = (await rpc(s.server, "initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "1" } }))!.result as any;
    expect(ok.protocolVersion).toBe("2025-03-26");
    expect(ok.capabilities.tools).toBeDefined();
    const unknown = (await rpc(s.server, "initialize", { protocolVersion: "1999-01-01" }))!.result as any;
    expect(unknown.protocolVersion).toBe("2025-06-18");
    expect(await s.server.handle({ jsonrpc: "2.0", method: "notifications/initialized" }, "k")).toBeNull();
    expect((await rpc(s.server, "nope"))!.error!.code).toBe(-32601);
  });

  test("data tools return structured results from the API", async () => {
    const log: Array<[string, unknown?]> = [];
    const s = setup({}, fakeApi(log));
    expect((await call(s, "lmns_chain", {})).structuredContent.names).toEqual(["NVDA", "TSLA"]);
    const weekly = await call(s, "lmns_chain", { name: "nvda", speed: "WEEKLY" });
    expect(weekly.structuredContent.speeds).toEqual([{ speed: "WEEKLY", strikes: [] }]);
    expect(log.some(([p]) => p === "/v1/chains/NVDA")).toBe(true);
    const q = await call(s, "lmns_quote", { series: SERIES, units: "2", side: "buy" });
    expect(q.isError).toBe(false);
    expect(q.structuredContent.quote.usdg).toBe("4000000");
    expect(JSON.parse(q.content[0]!.text)).toEqual(q.structuredContent);
    expect((await call(s, "lmns_pool", {})).structuredContent.navUsdg).toBe("1000000");
    expect((await call(s, "lmns_positions", {})).structuredContent.account).toBe(OWNER);
    expect(log.some(([p]) => p === `/v1/accounts/${OWNER}/positions`)).toBe(true);
  });

  test("bad arguments and API errors become tool errors, not crashes", async () => {
    const s = setup({}, fakeApi([], { "/v1/quote": () => { throw new ToolError("NO_VOL", "No volatility inputs are indexed for this series yet."); } }));
    const bad = await call(s, "lmns_quote", { series: "nope", units: "1", side: "buy" });
    expect(bad.isError).toBe(true);
    expect(bad.structuredContent.error).toBe("BAD_ARGUMENTS");
    const extra = await call(s, "lmns_quote", { series: SERIES, units: "1", side: "buy", surprise: 1 });
    expect(extra.structuredContent.error).toBe("BAD_ARGUMENTS");
    const api = await call(s, "lmns_quote", { series: SERIES, units: "1", side: "buy" });
    expect(api.structuredContent.error).toBe("NO_VOL");
    expect((await rpc(s.server, "tools/call", { name: "lmns_nope", arguments: {} }))!.error!.code).toBe(-32602);
  });

  test("stdio transport answers one JSON line per request and survives garbage", async () => {
    const s = setup();
    const out: string[] = [];
    async function* lines() {
      yield JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" });
      yield "{ not json";
      yield JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" });
      yield JSON.stringify([{ jsonrpc: "2.0", id: 2, method: "ping" }, { jsonrpc: "2.0", id: 3, method: "ping" }]);
    }
    await runStdio(s.server, lines(), (l) => out.push(l), "stdio");
    const parsed = out.map((l) => JSON.parse(l));
    expect(parsed.find((m) => m.id === 1).result.tools).toHaveLength(7);
    expect(parsed.some((m) => m.error?.code === -32700)).toBe(true);
    expect(parsed.filter((m) => m.id === 2 || m.id === 3)).toHaveLength(2);
    expect(parsed).toHaveLength(4);
  });
});

describe("HTTP transport", () => {
  const post = (app: ReturnType<typeof createMcpHttpApp>, body: unknown, headers: Record<string, string> = {}) =>
    app.request("/mcp", { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  test("POST /mcp serves JSON-RPC; notifications get 202; GET is 405", async () => {
    const app = createMcpHttpApp(setup().server, { token: undefined, allowedOrigins: [] });
    const res = await post(app, { jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as any).result.tools).toHaveLength(7);
    expect((await post(app, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(202);
    expect((await app.request("/mcp", { method: "GET" })).status).toBe(405);
    expect((await app.request("/mcp", { method: "POST", body: "{" })).status).toBe(400);
  });

  test("bearer token and origin are enforced", async () => {
    const app = createMcpHttpApp(setup().server, { token: "a-long-enough-test-token", allowedOrigins: ["https://agent.example"] });
    const body = { jsonrpc: "2.0", id: 1, method: "ping" };
    expect((await post(app, body)).status).toBe(401);
    expect((await post(app, body, { authorization: "Bearer wrong-wrong-wrong-wrong" })).status).toBe(401);
    expect((await post(app, body, { authorization: "Bearer a-long-enough-test-token" })).status).toBe(200);
    expect((await post(app, body, { authorization: "Bearer a-long-enough-test-token", origin: "https://evil.example" })).status).toBe(403);
    expect((await post(app, body, { authorization: "Bearer a-long-enough-test-token", origin: "https://agent.example" })).status).toBe(200);
  });
});

/** A stand-in for AgentRouter (todo 09): the rules the contract enforces, run on the calldata the server sent. */
function mockRouter(state: { spent: bigint; budget: bigint; maxPerTrade: bigint; expiresAt: number; canSell: boolean; canShield: boolean; revoked: boolean; stocks: Address[] }, calls: unknown[]): Executor {
  return {
    async send({ to, data }) {
      if (to !== ROUTER) throw new ToolError("TX_FAILED", "wrong target");
      const d = decodeFunctionData({ abi: AgentRouterAbi, data });
      const a = d.args as readonly any[];
      const nowS = Math.floor(NOW_MS / 1000);
      const revert = (why: string) => { throw new ToolError("TX_REVERTED", why); };
      if (state.revoked) revert("Revoked");
      if (nowS >= state.expiresAt) revert("Expired");
      if (d.functionName === "buyFor") {
        if (state.spent + 4_000_000n > state.budget) revert("BudgetExceeded");
        if (4_000_000n > state.maxPerTrade) revert("MaxPerTrade");
        state.spent += 4_000_000n;
      }
      if (d.functionName === "sellFor" && !state.canSell) revert("SellNotAllowed");
      if (d.functionName === "shieldFor") {
        if (!state.canShield) revert("ShieldNotAllowed");
        if (!state.stocks.includes(a[1])) revert("StockNotAllowed");
      }
      calls.push(d);
      return { txHash: `0x${"ab".repeat(32)}` as Hex };
    },
  };
}

describe("R2 executionOnlyViaPolicy", () => {
  const env = { AGENT_KEY, AGENT_POLICY: policy() };

  test("buy, sell and shield go to AgentRouter with the owner as beneficiary and the agent key as sender", async () => {
    const s = setup(env);
    expect(s.agent!.account.address).toBe(agentAddress);
    const buy = await call(s, "lmns_buy", { series: SERIES, units: "1" });
    expect(buy.isError).toBe(false);
    expect(buy.structuredContent.status).toBe("sent");
    expect(buy.structuredContent.owner).toBe(OWNER);
    const sell = await call(s, "lmns_sell", { series: SERIES, units: "1" });
    expect(sell.isError).toBe(false);
    const shield = await call(s, "lmns_shield", { name: "NVDA", tokenUnits: "1" });
    expect(shield.isError).toBe(false);
    expect(s.sent).toHaveLength(3);
    expect(s.sent.every((c) => c.to === ROUTER)).toBe(true);
    const [b, se, sh] = s.sent.map((c) => decodeFunctionData({ abi: AgentRouterAbi, data: c.data }));
    expect(b!.functionName).toBe("buyFor");
    expect(b!.args).toEqual([OWNER, SERIES, 10n ** 18n, 4_020_000n, BigInt(Math.floor(NOW_MS / 1000) + 300)]);
    expect(se!.functionName).toBe("sellFor");
    expect(se!.args).toEqual([OWNER, SERIES, 10n ** 18n, 3_900_000n, BigInt(Math.floor(NOW_MS / 1000) + 300)]);
    expect(sh!.functionName).toBe("shieldFor");
    expect(sh!.args).toEqual([OWNER, NVDA, 10n ** 18n, 1000, 5_000_000n, BigInt(Math.floor(NOW_MS / 1000) + 300)]);
  });

  test("refuses client-side: budget, per-trade limit, expiry, revoke, names, sell and shield rights", async () => {
    const cases: Array<[string, Record<string, unknown>, string, string, any]> = [
      ["budget", { budgetUsdg: "3000000" }, "lmns_buy", "BUDGET_EXCEEDED", { series: SERIES, units: "1" }],
      ["spent", { spentUsdg: "47000000" }, "lmns_buy", "BUDGET_EXCEEDED", { series: SERIES, units: "1" }],
      ["per trade", { maxPerTradeUsdg: "1000000" }, "lmns_buy", "MAX_PER_TRADE", { series: SERIES, units: "1" }],
      ["expiry", { expiresAt: Math.floor(NOW_MS / 1000) - 1 }, "lmns_buy", "POLICY_EXPIRED", { series: SERIES, units: "1" }],
      ["revoked", { revoked: true }, "lmns_sell", "POLICY_REVOKED", { series: SERIES, units: "1" }],
      ["names", { stocks: [TSLA] }, "lmns_buy", "STOCK_NOT_ALLOWED", { series: SERIES, units: "1" }],
      ["names shield", { stocks: [TSLA] }, "lmns_shield", "STOCK_NOT_ALLOWED", { name: "NVDA", tokenUnits: "1" }],
      ["sell right", { canSell: false }, "lmns_sell", "SELL_NOT_ALLOWED", { series: SERIES, units: "1" }],
      ["shield right", { canShield: false }, "lmns_shield", "SHIELD_NOT_ALLOWED", { name: "NVDA", tokenUnits: "1" }],
    ];
    for (const [label, over, tool, code, args] of cases) {
      const s = setup({ AGENT_KEY, AGENT_POLICY: policy(over) });
      const r = await call(s, tool, args);
      expect(`${label}:${r.structuredContent.error}`).toBe(`${label}:${code}`);
      expect(s.sent).toHaveLength(0);
    }
    const none = setup({ AGENT_KEY, AGENT_POLICY_FROM_ENV: "1" });
    expect((await call(none, "lmns_buy", { series: SERIES, units: "1" })).structuredContent.error).toBe("NO_POLICY");
    const stranger = setup({ AGENT_KEY, AGENT_POLICY: policy({ owner: TSLA }), AGENT_OWNER: OWNER });
    expect((await call(stranger, "lmns_buy", { series: SERIES, units: "1" })).structuredContent.error).toBe("NO_POLICY");
  });

  test("budget is cumulative across calls and stops the next buy", async () => {
    const s = setup({ AGENT_KEY, AGENT_POLICY: policy({ budgetUsdg: "9000000" }) });
    expect((await call(s, "lmns_buy", { series: SERIES, units: "1" })).isError).toBe(false);
    expect((await call(s, "lmns_buy", { series: SERIES, units: "1" })).isError).toBe(false);
    expect((await call(s, "lmns_buy", { series: SERIES, units: "1" })).structuredContent.error).toBe("BUDGET_EXCEEDED");
    expect(s.sent).toHaveLength(2);
  });

  test("the contract refuses too: with the client check off, the (mock) router reverts the same cases", async () => {
    const calls: unknown[] = [];
    const base = { spent: 0n, budget: 3_000_000n, maxPerTrade: 20_000_000n, expiresAt: Math.floor(NOW_MS / 1000) + 3600, canSell: true, canShield: true, revoked: false, stocks: [NVDA] };
    const run = async (state: typeof base, tool: string, args: unknown) => {
      const settings = loadMcpSettings({ AGENT_ROUTER: ROUTER, AGENT_OWNER: OWNER, AGENT_KEY, AGENT_POLICY: policy(), AGENT_POLICY_FROM_ENV: "1" });
      // clientSideChecks is off so the call reaches the router
      const { createAgentRuntime, envPolicyReader } = await import("./agent");
      const { createKeyedLimiter } = await import("./rate-limit");
      const { createMcpServer } = await import("./server");
      const agent = createAgentRuntime({ key: AGENT_KEY, owner: OWNER, router: ROUTER, policy: envPolicyReader(settings.policy), executor: () => mockRouter(state, calls), clientSideChecks: false, now: () => NOW_MS });
      const server = createMcpServer({ context: { api: fakeApi(), agent, defaultOwner: OWNER, router: ROUTER }, limiter: createKeyedLimiter({ limit: 0, windowMs: 1 }) });
      const r = await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }, "k");
      return (r!.result as any).structuredContent;
    };
    expect((await run(base, "lmns_buy", { series: SERIES, units: "1" })).error).toBe("TX_REVERTED");
    expect((await run({ ...base, budget: 50_000_000n, revoked: true }, "lmns_buy", { series: SERIES, units: "1" })).error).toBe("TX_REVERTED");
    expect((await run({ ...base, budget: 50_000_000n, expiresAt: 1 }, "lmns_buy", { series: SERIES, units: "1" })).error).toBe("TX_REVERTED");
    expect((await run({ ...base, budget: 50_000_000n, canSell: false }, "lmns_sell", { series: SERIES, units: "1" })).error).toBe("TX_REVERTED");
    expect((await run({ ...base, budget: 50_000_000n, stocks: [TSLA] }, "lmns_shield", { name: "NVDA", tokenUnits: "1" })).error).toBe("TX_REVERTED");
    expect(calls).toHaveLength(0);
    expect((await run({ ...base, budget: 50_000_000n }, "lmns_buy", { series: SERIES, units: "1" })).status).toBe("sent");
    expect(calls).toHaveLength(1);
  });

  test("a blocked buy from the API is reported, nothing is signed", async () => {
    const api = fakeApi([], { "/v1/intent/buy": () => { throw new ToolError("BUY_BLOCKED", "New purchases are closed while the market is closed.", "SESSION_CLOSED"); } });
    const s = setup(env, api);
    const r = await call(s, "lmns_buy", { series: SERIES, units: "1" });
    expect(r.structuredContent).toMatchObject({ error: "BUY_BLOCKED", reason: "SESSION_CLOSED" });
    expect(s.sent).toHaveLength(0);
  });
});

describe("R3 noKeyNoExecution", () => {
  test("without AGENT_KEY the execution tools answer READ_ONLY and data tools still work", async () => {
    const s = setup();
    expect(s.agent).toBeUndefined();
    for (const [tool, args] of [["lmns_buy", { series: SERIES, units: "1" }], ["lmns_sell", { series: SERIES, units: "1" }], ["lmns_shield", { name: "NVDA", tokenUnits: "1" }]] as const) {
      const r = await call(s, tool, args);
      expect(r.isError).toBe(true);
      expect(r.structuredContent.error).toBe("READ_ONLY");
      expect(r.structuredContent.message).toContain("AGENT_KEY");
    }
    expect(s.sent).toHaveLength(0);
    expect((await call(s, "lmns_pool", {})).isError).toBe(false);
    expect((await call(s, "lmns_chain", {})).isError).toBe(false);
    expect((await call(s, "lmns_quote", { series: SERIES, units: "1", side: "sell" })).isError).toBe(false);
  });

  test("the key never appears in any output, error or listing", async () => {
    const leaky: Executor = { send: async () => { throw new Error(`rpc failed for key ${AGENT_KEY}`); } };
    const s = setup({ AGENT_KEY, AGENT_POLICY: policy() }, fakeApi(), leaky);
    const out = [
      JSON.stringify(await rpc(s.server, "tools/list")),
      JSON.stringify(await call(s, "lmns_buy", { series: SERIES, units: "1" })),
      JSON.stringify(await call(s, "lmns_positions", {})),
    ].join("\n");
    expect(out).not.toContain(AGENT_KEY.slice(2));
    expect((await call(s, "lmns_buy", { series: SERIES, units: "1" })).structuredContent.error).toBe("INTERNAL_ERROR");
    expect(() => loadMcpSettings({ AGENT_KEY: `${AGENT_KEY}zz` })).toThrow(/AGENT_KEY/);
    try { loadMcpSettings({ AGENT_KEY: `${AGENT_KEY}zz` }); } catch (e) { expect(String(e)).not.toContain(AGENT_KEY.slice(2)); }
  });
});

describe("R6 copyRules", () => {
  const banned = [/\bAPY\b/i, /\byield/i, /\bincome\b/i, /can'?t lose/i, /free options?/i, /\bno fees?\b/i, /no time decay/i, /partner/i, /endorse/i, /official/i, /guarantee/i];
  const endorsed = [/robinhood/i, /chainlink/i, /cboe/i];
  test("tool names, descriptions, schema text and server instructions follow CLAUDE.md copy rules", async () => {
    const s = setup();
    const init = (await rpc(s.server, "initialize", {}))!.result as { instructions: string };
    const texts = [init.instructions, JSON.stringify(toolListing())];
    for (const text of texts) {
      for (const re of banned) expect(`${re}:${re.test(text)}`).toBe(`${re}:false`);
    }
    // Venue names may appear only as plain facts, never next to endorsement wording (none of the banned words exist above).
    for (const tool of toolListing()) for (const re of endorsed) expect(`${tool.name}:${re.test(tool.description)}`).toBe(`${tool.name}:false`);
  });
});

describe("R7 rateLimitPerAgent", () => {
  test("each caller gets its own window, over-limit calls are told when to retry, and the window resets", async () => {
    let now = NOW_MS;
    const settings = loadMcpSettings({ MCP_RATE_LIMIT_PER_MINUTE: "3" });
    const { server } = buildMcp(settings, { api: fakeApi(), now: () => now });
    const run = async (key: string) => (await server.handle({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lmns_pool", arguments: {} } }, key))!.result as any;
    for (let i = 0; i < 3; i++) expect((await run("agent-a")).isError).toBe(false);
    const limited = await run("agent-a");
    expect(limited.isError).toBe(true);
    expect(limited.structuredContent.error).toBe("RATE_LIMITED");
    expect(limited.structuredContent.retryAfterSeconds).toBeGreaterThan(0);
    expect((await run("agent-b")).isError).toBe(false);
    now += 61_000;
    expect((await run("agent-a")).isError).toBe(false);
  });

  test("listing and ping are not counted, so a limited agent can still discover tools", async () => {
    const settings = loadMcpSettings({ MCP_RATE_LIMIT_PER_MINUTE: "1" });
    const { server } = buildMcp(settings, { api: fakeApi() });
    for (let i = 0; i < 5; i++) expect(((await server.handle({ jsonrpc: "2.0", id: i + 1, method: "tools/list" }, "a"))!.result as any).tools).toHaveLength(7);
  });
});

describe("17b R1 policyFromChain", () => {
  const ZERO = "0x0000000000000000000000000000000000000000";
  const onChain = (over: Record<string, unknown> = {}, stocks: Address[] = [NVDA], remaining = 50_000_000n): ChainReader & { reads: string[] } => {
    const reads: string[] = [];
    return {
      reads,
      async readContract({ address, functionName }) {
        reads.push(`${address}:${functionName}`);
        if (functionName === "policyOf") {
          return { agent: agentAddress, budgetUsdg: 50_000_000n, spentUsdg: 50_000_000n - remaining, maxPerTradeUsdg: 20_000_000n,
            expiresAt: BigInt(Math.floor(NOW_MS / 1000) + 3600), canSell: true, canShield: true, revoked: false, ...over };
        }
        if (functionName === "allowedStocks") return stocks;
        if (functionName === "remainingBudget") return remaining;
        throw new Error("unexpected");
      },
    };
  };

  test("with a router and no env flag the policy comes from the chain, not AGENT_POLICY", async () => {
    const chain = onChain();
    const s = setup({ AGENT_KEY, AGENT_POLICY: policy({ budgetUsdg: "1" }), AGENT_POLICY_FROM_ENV: "0" }, fakeApi(), undefined, chain);
    expect(s.settings.policy).toBeUndefined();
    expect((await call(s, "lmns_buy", { series: SERIES, units: "1" })).structuredContent.status).toBe("sent");
    expect(chain.reads).toEqual([`${ROUTER}:policyOf`, `${ROUTER}:allowedStocks`, `${ROUTER}:remainingBudget`]);
  });

  test("chain state is refused with the contract's reasons: revoked, expired, name, budget, no policy", async () => {
    const run = async (chain: ChainReader, tool = "lmns_buy", args: unknown = { series: SERIES, units: "1" }) =>
      (await call(setup({ AGENT_KEY }, fakeApi(), undefined, chain), tool, args)).structuredContent.error;
    expect(await run(onChain({ revoked: true }))).toBe("POLICY_REVOKED");
    expect(await run(onChain({ expiresAt: 1n }))).toBe("POLICY_EXPIRED");
    expect(await run(onChain({}, [TSLA]))).toBe("STOCK_NOT_ALLOWED");
    expect(await run(onChain({}, [NVDA], 1_000_000n))).toBe("BUDGET_EXCEEDED");
    expect(await run(onChain({ agent: ZERO }))).toBe("NO_POLICY");
  });

  test("spend follows the chain: the next read sees the lower remaining budget", async () => {
    let remaining = 9_000_000n;
    const chain: ChainReader = { readContract: (a) => onChain({}, [NVDA], remaining).readContract(a) };
    const s = setup({ AGENT_KEY }, fakeApi(), undefined, chain);
    expect((await call(s, "lmns_buy", { series: SERIES, units: "1" })).isError).toBe(false);
    remaining = 3_000_000n; // the router counted the actual cost
    expect((await call(s, "lmns_buy", { series: SERIES, units: "1" })).structuredContent.error).toBe("BUDGET_EXCEEDED");
  });

  test("a failing RPC is reported without leaking its message", async () => {
    const chain: ChainReader = { readContract: async () => { throw new Error("https://secret-rpc.example/key123 down"); } };
    const r = await call(setup({ AGENT_KEY }, fakeApi(), undefined, chain), "lmns_buy", { series: SERIES, units: "1" });
    expect(r.structuredContent.error).toBe("POLICY_READ_FAILED");
    expect(JSON.stringify(r)).not.toContain("secret-rpc");
  });
});

describe("F40 each MCP caller is counted on its own address", () => {
  // The real REST rate limiter behind a fetch stub: what the MCP's loopback connection would hit.
  async function apiBehindLimiter(limit: number) {
    const { Hono } = await import("hono");
    const { rateLimit } = await import("../api/rate-limit");
    const { createApiClient } = await import("./api-client");
    const rest = new Hono();
    rest.use("*", rateLimit({ limit, windowMs: 60_000, clientIpHeader: "" }));
    rest.get("/v1/pool", (context) => context.json({ navUsdg: "1000000" }));
    const seen: Array<string | null> = [];
    const fetchImpl = (async (url: string, init: RequestInit) => {
      seen.push(new Headers(init.headers).get("x-forwarded-for"));
      return rest.request(url.replace("http://api.local", ""), init);
    }) as unknown as typeof fetch;
    return { api: createApiClient("http://api.local", fetchImpl), seen };
  }
  const post = async (app: ReturnType<typeof createMcpHttpApp>, address: string): Promise<any> =>
    (await app.request("/mcp", {
      method: "POST", headers: { "content-type": "application/json", "x-forwarded-for": address },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "lmns_pool", arguments: {} } }),
    })).json();

  test("the caller's address reaches the API, so one caller cannot lock the others out of the API's per-client bucket", async () => {
    const { api, seen } = await apiBehindLimiter(2);
    const { server } = buildMcp(loadMcpSettings({ MCP_RATE_LIMIT_PER_MINUTE: "100" }), { api, now: () => NOW_MS });
    const app = createMcpHttpApp(server, { token: undefined, allowedOrigins: [] });
    // Caller A burns its API allowance...
    for (let i = 0; i < 4; i++) await post(app, "203.0.113.7");
    // ...and caller B, a different address, is untouched.
    const b = await post(app, "198.51.100.9");
    expect(b.result.isError).toBe(false);
    expect(seen.slice(0, 4)).toEqual(["203.0.113.7", "203.0.113.7", "203.0.113.7", "203.0.113.7"]);
    expect(seen[4]).toBe("198.51.100.9");
  });

  test("the MCP's own limiter counts an IPv6 caller by its /64", async () => {
    const { server } = buildMcp(loadMcpSettings({ MCP_RATE_LIMIT_PER_MINUTE: "2" }), { api: fakeApi(), now: () => NOW_MS });
    const app = createMcpHttpApp(server, { token: undefined, allowedOrigins: [] });
    await post(app, "2001:db8:1:2::1");
    await post(app, "2001:db8:1:2::abcd");
    const third = await post(app, "2001:db8:1:2:ffff:ffff:ffff:ffff");
    expect(third.result.structuredContent.error).toBe("RATE_LIMITED");
    expect((await post(app, "2001:db8:1:3::1")).result.isError).toBe(false);
  });
});
