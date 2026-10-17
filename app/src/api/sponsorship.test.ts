import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { pino } from "pino";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { OptionEngineAbi } from "../abi";
import { withRpcBudget } from "../aa/chain";
import { ACCOUNT, ENGINE, OWNER, USDG, createTestServices } from "../aa/test-support";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import { TtlCache } from "./cache";
import { registerIntentUserOp } from "./routes/intent-userop";
import { createSponsorshipGate } from "./sponsorship";
import type { ApiDependencies } from "./types";

const suite = testDatabaseUrl() ? describe : describe.skip;
const SERIES = `0x${"a0".repeat(32)}`;
const TOKEN = "0x00000000000000000000000000000000000000f7";
const WAD = 10n ** 18n;
const addr = (n: number): Address => `0x${n.toString(16).padStart(40, "0")}` as Address;
const MICRO = (usdg: number) => String(Math.round(usdg * 1_000_000));

suite("F25/F31 sponsorship policy", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = (await createTestDatabase("sponsorship"))!;
    await applyMigrations(db);
    await db.sql`insert into series (id, stock_token, is_call, speed, tau_s, strike, token, norm, last_accrual, listed_at, listed_block, listed_tx, listed_log)
      values (${SERIES}, ${addr(0xaa01)}, true, 'DAILY', 86400, 100, ${TOKEN}, 1, now(), now(), 1, '0x', 0)`;
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.sql`truncate sponsorship_grants, invite_redemptions, app_settings, balances`;
  });

  /** The real intent routes are stood in for by routes that echo the numbers a test chooses. */
  function build(options: { limits?: Record<string, number>; services?: Parameters<typeof createTestServices>[0]; invites?: boolean } = {}) {
    const t = createTestServices(options.services);
    let signed = 0;
    const realSign = t.services.sponsor!.sign.bind(t.services.sponsor!);
    (t.services.sponsor as { sign: unknown }).sign = async (...args: Parameters<typeof realSign>) => { signed += 1; return realSign(...args); };
    const deps = {
      sql: db.sql,
      config: {
        API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "x-test-ip", RPC_URL_OVERRIDE: "", PUBLIC_RPC_URL: "http://rpc.invalid",
        INVITES_REQUIRED: options.invites === true, ...options.limits,
      },
      deployment: { contracts: { engine: ENGINE, usdg: USDG } },
      logger: pino({ level: "silent" }), cache: new TtlCache(), aa: t.services,
    } as unknown as ApiDependencies;
    const app = new OpenAPIHono();
    registerIntentUserOp(app, deps);
    const body = z.object({ account: z.string(), owner: z.string().optional(), cost: z.string().optional(), tokens: z.string().optional(), quote: z.string().optional() });
    for (const kind of ["buy", "sell", "shield"] as const) {
      app.openapi(
        createRoute({ method: "post", path: `/v1/intent/${kind}`, request: { body: { required: true, content: { "application/json": { schema: body } } } },
          responses: { 200: { description: "ok", content: { "application/json": { schema: z.any() } } } } }),
        (context) => {
          const input = context.req.valid("json");
          const data = encodeFunctionData({ abi: OptionEngineAbi, functionName: "buy", args: [SERIES as Hex, WAD, 5_000_000n, 1_800_000_000n, input.account as Address] });
          return context.json({
            kind, to: ENGINE, data, value: "0", approvals: kind === "sell" ? [] : [{ token: USDG, spender: ENGINE, amount: input.cost ?? MICRO(10) }],
            maxCostUsdg: input.cost ?? MICRO(10), tokens: input.tokens ?? String(WAD), series: SERIES, quote: { usdg: input.quote ?? MICRO(10) },
            deadline: 1_800_000_000, queued: false, note: null,
          }, 200);
        },
      );
    }
    const call = async (kind: "buy" | "sell" | "shield", payload: Record<string, unknown>, ip = "203.0.113.5") => {
      const response = await app.request(`/v1/intent/${kind}?format=userop`, {
        method: "POST", headers: { "content-type": "application/json", "x-test-ip": ip }, body: JSON.stringify(payload),
      });
      return { status: response.status, json: await response.json() as Record<string, any> };
    };
    return { ...t, deps, app, call, signed: () => signed };
  }

  const fund = (t: ReturnType<typeof build>, account: Address, usdg: number) => t.state.balances.set(`${USDG.toLowerCase()}:${account.toLowerCase()}`, BigInt(Math.round(usdg * 1e6)));
  const hold = (account: Address, tokens: bigint) => db.sql`insert into balances (token, account, balance, updated_block) values (${TOKEN}, ${account.toLowerCase()}, ${(Number(tokens) / 1e18).toString()}, 1)`;
  const registerAccount = (t: ReturnType<typeof build>, account: Address, owner: Address) => { t.state.deployed.add(account.toLowerCase()); t.state.owners.set(account.toLowerCase(), owner.toLowerCase() as Address); };

  test("a funded, deployed account with a real buy is sponsored and the grant is booked", async () => {
    const t = build();
    fund(t, ACCOUNT, 100);
    const { json } = await t.call("buy", { account: ACCOUNT });
    expect(json.sponsored).toBe(true);
    expect(json.sponsorship).toEqual({ requested: true, granted: true });
    expect(t.signed()).toBeGreaterThan(0);
    const rows = await db.sql`select grp, kind, account, owner from sponsorship_grants`;
    expect(rows.map((r) => ({ ...r }))).toEqual([{ grp: "entry", kind: "buy", account: ACCOUNT.toLowerCase(), owner: OWNER.toLowerCase() }]);
  });

  test("F25 exploit: 1,000 fresh owners asking for sponsored sells get 0 signatures and book nothing", async () => {
    const t = build();
    for (let i = 0; i < 1000; i++) {
      const account = addr(0x10000 + i);
      registerAccount(t, account, addr(0x20000 + i));
      const { json } = await t.call("sell", { account, owner: addr(0x20000 + i) }, `198.51.100.${i % 250}`);
      expect(json.sponsored).toBe(false);
      expect(json.sponsorship.reason).toBe("NO_POSITION");
    }
    expect(t.signed()).toBe(0);
    expect((await db.sql`select count(*)::int as n from sponsorship_grants`)[0]!.n).toBe(0);
  });

  test("F25/F31 exploit: sybil accounts from one network get at most the per-network quota", async () => {
    const t = build({ limits: { SPONSOR_ENTRY_PER_IP_DAILY: 4, SPONSOR_ENTRY_PER_ACCOUNT_DAILY: 10 } });
    let granted = 0;
    for (let i = 0; i < 40; i++) {
      const account = addr(0x30000 + i);
      registerAccount(t, account, addr(0x40000 + i));
      fund(t, account, 50);
      // one IPv6 /64, many addresses inside it
      const { json } = await t.call("buy", { account }, `2001:db8:77:9::${(i + 1).toString(16)}`);
      if (json.sponsored) granted++;
      else expect(json.sponsorship.reason).toBe("QUOTA_NETWORK");
    }
    expect(granted).toBe(4);
    expect((await db.sql`select count(*)::int as n from sponsorship_grants`)[0]!.n).toBe(4);
  });

  test("per-account and per-owner quotas hold even when the network changes", async () => {
    const t = build({ limits: { SPONSOR_ENTRY_PER_ACCOUNT_DAILY: 2, SPONSOR_ENTRY_PER_OWNER_DAILY: 3 } });
    fund(t, ACCOUNT, 500);
    const results: (string | undefined)[] = [];
    for (let i = 0; i < 4; i++) results.push((await t.call("buy", { account: ACCOUNT }, `192.0.2.${i + 1}`)).json.sponsorship.reason);
    expect(results).toEqual([undefined, undefined, "QUOTA_ACCOUNT", "QUOTA_ACCOUNT"]);
    // the same owner with a second account: one slot left, then the owner quota
    const second = addr(0x50001); const third = addr(0x50002);
    for (const a of [second, third]) { registerAccount(t, a, OWNER); fund(t, a, 500); }
    expect((await t.call("buy", { account: second }, "192.0.2.90")).json.sponsored).toBe(true);
    expect((await t.call("buy", { account: third }, "192.0.2.91")).json.sponsorship.reason).toBe("QUOTA_OWNER");
  });

  test("dust: a buy under the minimum notional, or a sell under the minimum proceeds, is not sponsored", async () => {
    const t = build();
    fund(t, ACCOUNT, 100);
    const buy = (await t.call("buy", { account: ACCOUNT, cost: MICRO(0.000001) })).json;
    expect(buy.sponsorship.reason).toBe("BELOW_MINIMUM");
    expect(buy.sponsored).toBe(false);
    await hold(ACCOUNT, 5n * WAD);
    const sell = (await t.call("sell", { account: ACCOUNT, tokens: String(WAD), quote: MICRO(0.0001) })).json;
    expect(sell.sponsorship.reason).toBe("BELOW_MINIMUM");
    const fine = (await t.call("sell", { account: ACCOUNT, tokens: String(WAD), quote: MICRO(8) })).json;
    expect(fine.sponsored).toBe(true);
  });

  test("a buy needs the USDG on hand and a sell needs the tokens", async () => {
    const t = build();
    expect((await t.call("buy", { account: ACCOUNT })).json.sponsorship.reason).toBe("INSUFFICIENT_BALANCE");
    expect((await t.call("sell", { account: ACCOUNT, tokens: String(2n * WAD) })).json.sponsorship.reason).toBe("NO_POSITION");
    await hold(ACCOUNT, WAD);
    expect((await t.call("sell", { account: ACCOUNT, tokens: String(2n * WAD) })).json.sponsorship.reason).toBe("NO_POSITION"); // holds less than it sells
    expect((await t.call("sell", { account: ACCOUNT, tokens: String(WAD) })).json.sponsored).toBe(true);
  });

  test("F25(4): with invites required, a forged owner on a deployed account does not borrow someone else's approval", async () => {
    const t = build({ invites: true });
    fund(t, ACCOUNT, 100);
    const approved = addr(0xa99);
    await db.sql`insert into invite_redemptions (address, code_hash) values (${approved}, 'h')`;
    // ACCOUNT is owned (on chain) by OWNER, who is not approved; the request names an approved address as `owner`.
    const forged = (await t.call("buy", { account: ACCOUNT, owner: approved })).json;
    expect(forged.sponsorship.reason).toBe("INVITE_REQUIRED");
    expect(forged.sponsored).toBe(false);
    await db.sql`insert into invite_redemptions (address, code_hash) values (${OWNER.toLowerCase()}, 'h2')`;
    expect((await t.call("buy", { account: ACCOUNT, owner: approved })).json.sponsored).toBe(true); // the real owner is approved
  });

  test("sells need no invite, and entries cannot use up the exit budget (separate groups)", async () => {
    const t = build({ invites: true, limits: { SPONSOR_ENTRY_GLOBAL_DAILY: 1 } });
    const approved = OWNER.toLowerCase();
    await db.sql`insert into invite_redemptions (address, code_hash) values (${approved}, 'h')`;
    fund(t, ACCOUNT, 500);
    expect((await t.call("buy", { account: ACCOUNT })).json.sponsored).toBe(true);
    expect((await t.call("buy", { account: ACCOUNT })).json.sponsorship.reason).toBe("QUOTA_GLOBAL");
    const holder = addr(0x60001);
    registerAccount(t, holder, addr(0x60002)); // not invited
    await hold(holder, WAD);
    expect((await t.call("sell", { account: holder })).json.sponsored).toBe(true);
  });

  test("fail closed: an unreadable chain or an empty RPC budget signs nothing and the operation still comes back unsponsored", async () => {
    const down = build();
    fund(down, ACCOUNT, 100);
    down.state.down = false;
    const original = down.services.chain.tokenBalance;
    (down.services.chain as { tokenBalance: unknown }).tokenBalance = async () => { throw new Error("rpc down"); };
    const first = (await down.call("buy", { account: ACCOUNT })).json;
    expect(first.sponsorship.reason).toBe("UNAVAILABLE");
    expect(first.sponsored).toBe(false);
    expect(first.userOp.signature).toBe("0x");
    (down.services.chain as { tokenBalance: unknown }).tokenBalance = original;
    expect(down.signed()).toBe(0);
  });

  test("F25: when the operation cannot be simulated the sponsor does not sign and the booked grant is given back", async () => {
    const t = build({ services: { bundler: { failEstimate: true } } });
    fund(t, ACCOUNT, 100);
    const { status, json } = await t.call("buy", { account: ACCOUNT });
    expect(status).toBe(409);
    expect(json.error).toBe("SPONSOR_SIMULATION_FAILED");
    expect((await db.sql`select count(*)::int as n from sponsorship_grants`)[0]!.n).toBe(0); // released
    expect(json.userOp).toBeUndefined();
  });

  test("concurrent requests cannot both take the last slot", async () => {
    const t = build({ limits: { SPONSOR_ENTRY_GLOBAL_DAILY: 5, SPONSOR_ENTRY_PER_ACCOUNT_DAILY: 100, SPONSOR_ENTRY_PER_OWNER_DAILY: 100, SPONSOR_ENTRY_PER_IP_DAILY: 100 } });
    fund(t, ACCOUNT, 5000);
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => t.call("buy", { account: ACCOUNT }, `203.0.113.${i + 1}`)));
    expect(results.filter((r) => r.json.sponsored).length).toBe(5);
    expect((await db.sql`select count(*)::int as n from sponsorship_grants`)[0]!.n).toBe(5);
  });

  test("a denied request still gets a usable unsponsored operation", async () => {
    const t = build();
    const { status, json } = await t.call("buy", { account: ACCOUNT }); // no USDG on the account
    expect(status).toBe(200);
    expect(json.sponsored).toBe(false);
    expect(json.userOp.paymaster).toBeUndefined();
    expect(json.userOpHash).toMatch(/^0x[0-9a-f]{64}$/);
    expect(json.fallback.to).toBe(ENGINE);
  });

  test("gate used directly: a missing owner on a deployed account is refused", async () => {
    const t = build();
    t.state.owners.delete(ACCOUNT.toLowerCase());
    const gate = createSponsorshipGate({ deps: t.deps, chain: t.services.chain, kernelValidator: t.services.config.kernelValidator, usdg: USDG });
    const decision = await gate.evaluate({ kind: "buy", account: ACCOUNT, owner: OWNER, ipKey: "x", plain: { maxCostUsdg: MICRO(10) } });
    expect(decision).toMatchObject({ granted: false, reason: "OWNER_UNVERIFIED" });
  });
});

describe("F32 the API's chain reads have a budget and caches", () => {
  test("a flood of userop requests costs the node at most the budget, then answers 503 without any read", async () => {
    const t = createTestServices();
    const clock = { at: 1_000_000 };
    const budgeted = withRpcBudget(t.services.chain, { callsPerSecond: 5, burst: 10, now: () => clock.at });
    const { buildUserOp } = await import("../aa/userop");
    const services = { ...t.services, chain: budgeted };
    const outcomes: string[] = [];
    for (let i = 0; i < 200; i++) {
      // new nonce lane each time so the nonce cache cannot help: the worst case
      try { await buildUserOp(services, { account: ACCOUNT, calls: [{ to: ENGINE, value: 0n, data: "0x12345678" }], sponsor: false, nonceLane: i }); outcomes.push("ok"); }
      catch (error) { outcomes.push((error as { apiError?: string }).apiError ?? "?"); }
    }
    expect(budgeted.stats.reads).toBeLessThanOrEqual(10); // the burst, no refill: the clock never moved
    expect(outcomes.filter((o) => o === "CHAIN_UNAVAILABLE").length).toBeGreaterThan(150);
    expect(t.state.reads.length).toBeLessThanOrEqual(10);
    clock.at += 2_000; // two seconds later the budget has refilled by 10
    await buildUserOp(services, { account: ACCOUNT, calls: [{ to: ENGINE, value: 0n, data: "0x12345678" }], sponsor: false, nonceLane: 999 });
  });

  test("one userop request makes at most 3 chain reads for a deployed account and 4 for a new one; repeats are served from cache", async () => {
    const t = createTestServices();
    const budgeted = withRpcBudget(t.services.chain, { callsPerSecond: 5, burst: 10, now: () => 1_000_000 });
    const { buildUserOp } = await import("../aa/userop");
    const services = { ...t.services, chain: budgeted };
    const input = { account: ACCOUNT, calls: [{ to: ENGINE, value: 0n, data: "0x12345678" as const }], sponsor: false };
    await buildUserOp(services, input);
    expect(budgeted.stats.reads).toBeLessThanOrEqual(3); // code, nonce, fees
    await buildUserOp(services, input);
    expect(budgeted.stats.reads).toBeLessThanOrEqual(3); // all cached
    const fresh = createTestServices();
    fresh.state.deployed.clear();
    const budget2 = withRpcBudget(fresh.services.chain, { callsPerSecond: 5, burst: 10, now: () => 1_000_000 });
    await buildUserOp({ ...fresh.services, chain: budget2 }, { ...input, owner: OWNER });
    expect(budget2.stats.reads).toBeLessThanOrEqual(4); // code, predict, nonce, fees
  });
});
