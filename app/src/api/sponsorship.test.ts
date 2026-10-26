import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { createRoute, OpenAPIHono, z } from "@hono/zod-openapi";
import { pino } from "pino";
import { encodeFunctionData, type Address, type Hex } from "viem";
import { OptionEngineAbi } from "../abi";
import { withRpcBudget } from "../aa/chain";
import { KERNEL_ECDSA_VALIDATOR, KERNEL_V33_FACTORY } from "../aa/config";
import { KERNEL_V33_IMPLEMENTATION, predictKernelAddressOffline } from "../aa/counterfactual";
import { kernelInitData } from "../aa/kernel";
import { kernelSalt } from "../aa/userop";
import { ACCOUNT, ENGINE, NOW_MS, OWNER, USDG, createTestServices } from "../aa/test-support";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import { TtlCache } from "./cache";
import { registerIntentUserOp } from "./routes/intent-userop";
import { createSponsorshipGate, limitsFromConfig, sponsorshipCapWarning } from "./sponsorship";
import { sellLaneProofMessage } from "./sell-lane-proof";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";
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

  /** Relay a built operation the way a client does (the owner's signature is not checked by the fake bundler). */
  const relay = async (t: ReturnType<typeof build>, json: Record<string, any>) => {
    const response = await t.app.request("/v1/userop/send", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ userOp: { ...json.userOp, signature: `0x${"11".repeat(65)}` } }),
    });
    return response.status;
  };
  const spends = async () => (await db.sql`select count(*)::int as n from sponsorship_grants where submitted_at is not null`)[0]!.n as number;

  const fund = (t: ReturnType<typeof build>, account: Address, usdg: number) => t.state.balances.set(`${USDG.toLowerCase()}:${account.toLowerCase()}`, BigInt(Math.round(usdg * 1e6)));
  const hold = (account: Address, tokens: bigint) => db.sql`insert into balances (token, account, balance, updated_block) values (${TOKEN}, ${account.toLowerCase()}, ${(Number(tokens) / 1e18).toString()}, 1)`;
  const registerAccount = (t: ReturnType<typeof build>, account: Address, owner: Address) => { t.state.deployed.add(account.toLowerCase()); t.state.owners.set(account.toLowerCase(), owner.toLowerCase() as Address); };
  /** The operation at the account's current lane-0 nonce was included on chain (by any bundler): the nonce moves on. */
  const executed = (t: ReturnType<typeof build>, account: Address) => {
    const key = `${account.toLowerCase()}:0`;
    t.state.nonces.set(key, (t.state.nonces.get(key) ?? 0n) + 1n);
  };
  const grants = async () => (await db.sql`select count(*)::int as n from sponsorship_grants`)[0]!.n as number;

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

  test("F26 (decision 44): a deployed account the paymaster does not know, or one on another implementation, is not signed for", async () => {
    const t = build();
    fund(t, ACCOUNT, 100);
    t.state.kernelAccounts = new Set(); // the paymaster never saw it deployed through the Kernel factory
    const unknown = (await t.call("buy", { account: ACCOUNT })).json;
    expect(unknown.sponsored).toBe(false);
    expect(unknown.sponsorship.reason).toBe("ACCOUNT_UNREGISTERED");
    t.state.kernelAccounts = new Set([ACCOUNT.toLowerCase()]);
    t.state.implementations.set(ACCOUNT.toLowerCase(), "0x00000000000000000000000000000000000bad01");
    const upgraded = (await t.call("buy", { account: ACCOUNT })).json;
    expect(upgraded.sponsored).toBe(false);
    expect(upgraded.sponsorship.reason).toBe("ACCOUNT_UNSUPPORTED");
    expect(t.signed()).toBe(0);
    expect((await db.sql`select count(*)::int as n from sponsorship_grants`)[0]!.n).toBe(0);
    t.state.implementations.delete(ACCOUNT.toLowerCase());
    expect((await t.call("buy", { account: ACCOUNT })).json.sponsored).toBe(true);
  });

  test("R17 (decision 62): a standard account someone else deployed is queued for registerKernelAccount; a non-standard one is not", async () => {
    await db.sql`truncate kernel_registrations`;
    const t = build();
    const owner = addr(0xbeef01);
    const standard = predictKernelAddressOffline({ factory: KERNEL_V33_FACTORY as Address, validator: KERNEL_ECDSA_VALIDATOR as Address,
      implementation: KERNEL_V33_IMPLEMENTATION as Address }, owner, 0);
    registerAccount(t, standard, owner);
    fund(t, standard, 100);
    t.state.kernelAccounts = new Set(); // deployed through the public factory by a stranger: the paymaster never saw it
    const first = (await t.call("buy", { account: standard })).json;
    expect(first.sponsored).toBe(false);
    expect(first.sponsorship.reason).toBe("ACCOUNT_REGISTERING");
    const rows = await db.sql`select account, owner, init_data, salt from kernel_registrations`;
    expect(rows.map((r) => ({ ...r }))).toEqual([{ account: standard.toLowerCase(), owner, init_data: kernelInitData(KERNEL_ECDSA_VALIDATOR as Address, owner),
      salt: kernelSalt(0) }]);
    await t.call("buy", { account: standard }); // asking again queues nothing new
    expect((await db.sql`select count(*)::int as n from kernel_registrations`)[0]!.n).toBe(1);
    // The keeper registered it: sponsored from then on.
    t.state.kernelAccounts = new Set([standard.toLowerCase()]);
    await Bun.sleep(0);
    const t2 = build();
    registerAccount(t2, standard, owner); fund(t2, standard, 100); t2.state.kernelAccounts = new Set([standard.toLowerCase()]);
    expect((await t2.call("buy", { account: standard })).json.sponsored).toBe(true);
    // An account whose address is not the standard setup of its stored owner (another index, another init) is not queued.
    const other = build();
    fund(other, ACCOUNT, 100);
    other.state.kernelAccounts = new Set();
    expect((await other.call("buy", { account: ACCOUNT })).json.sponsorship.reason).toBe("ACCOUNT_UNREGISTERED");
    expect((await db.sql`select count(*)::int as n from kernel_registrations`)[0]!.n).toBe(1);
    expect(t.signed() + other.signed()).toBe(0);
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
    for (let i = 0; i < 4; i++) {
      results.push((await t.call("buy", { account: ACCOUNT }, `192.0.2.${i + 1}`)).json.sponsorship.reason);
      executed(t, ACCOUNT);
    }
    expect(results).toEqual([undefined, undefined, "QUOTA_ACCOUNT", "QUOTA_ACCOUNT"]); // every signed nonce counts, relayed or not
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

  test("sells need no invite, and entries cannot use up the exit budget (exits keep their reserved share)", async () => {
    const t = build({ invites: true, limits: { SPONSOR_ENTRY_GLOBAL_DAILY: 1, SPONSOR_EXIT_GLOBAL_DAILY: 1 } });
    const approved = OWNER.toLowerCase();
    await db.sql`insert into invite_redemptions (address, code_hash) values (${approved}, 'h')`;
    fund(t, ACCOUNT, 500);
    const first = await t.call("buy", { account: ACCOUNT });
    expect(first.json.sponsored).toBe(true);
    expect((await t.call("buy", { account: ACCOUNT })).json.sponsored).toBe(true); // the same nonce: the same grant
    executed(t, ACCOUNT); // bundled anywhere: it was signed, so it counted when it was signed
    expect((await t.call("buy", { account: ACCOUNT })).json.sponsorship.reason).toBe("QUOTA_GLOBAL");
    const holder = addr(0x60001);
    registerAccount(t, holder, addr(0x60002)); // not invited
    await hold(holder, WAD);
    expect((await t.call("sell", { account: holder })).json.sponsored).toBe(true);
    executed(t, holder);
    expect((await t.call("sell", { account: holder })).json.sponsorship.reason).toBe("QUOTA_GLOBAL"); // 1 entry + 1 exit = the day's total
    expect(await grants()).toBe(2);
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
    const t = build({ limits: { SPONSOR_ENTRY_GLOBAL_DAILY: 5, SPONSOR_ENTRY_PER_IP_DAILY: 100 } });
    const accounts = Array.from({ length: 30 }, (_, i) => addr(0x55000 + i));
    for (const [i, a] of accounts.entries()) { registerAccount(t, a, addr(0x56000 + i)); fund(t, a, 50); }
    const results = await Promise.all(accounts.map((account, i) => t.call("buy", { account }, `203.0.113.${i + 1}`)));
    expect(results.filter((r) => r.json.sponsored).length).toBe(5);
    expect(await grants()).toBe(5);
    // and 30 concurrent rebuilds of one operation book exactly one grant
    await db.sql`truncate sponsorship_grants`;
    fund(t, ACCOUNT, 5000);
    const same = await Promise.all(Array.from({ length: 30 }, (_, i) => t.call("buy", { account: ACCOUNT }, `198.51.100.${i + 1}`)));
    expect(same.every((r) => r.json.sponsored)).toBe(true);
    expect(await grants()).toBe(1);
  });

  test("R11 PoC: 1,000 sponsored sell builds that are never submitted leave the next honest exit sponsored", async () => {
    const t = build();
    const tokens = String(WAD);
    for (let i = 0; i < 1000; i++) {
      const account = addr(0x70000 + i);
      registerAccount(t, account, addr(0x80000 + i));
      await hold(account, WAD);
      const { json } = await t.call("sell", { account, tokens }, `2001:db8:${(i % 4000).toString(16)}::1`);
      expect(json.sponsored).toBe(true); // the attacker is signed for ...
    }
    expect(await spends()).toBe(0); // ... and has spent nothing
    const holder = addr(0x90001);
    registerAccount(t, holder, addr(0x90002));
    await hold(holder, WAD);
    const honest = await t.call("sell", { account: holder, tokens }, "198.51.100.7");
    expect(honest.json.sponsored).toBe(true);
    expect(honest.json.sponsorship).toEqual({ requested: true, granted: true });
    expect(await relay(t, honest.json)).toBe(200);
    expect(await spends()).toBe(1);
  });

  test("R3-05/R11: rebuilding the same operation over and over, from any client, books one grant", async () => {
    const t = build({ limits: { SPONSOR_EXIT_PER_ACCOUNT_DAILY: 3, SPONSOR_EXIT_PER_IP_DAILY: 1000, SPONSOR_EXIT_PER_OWNER_DAILY: 1000, SPONSOR_EXIT_GLOBAL_DAILY: 5, SPONSOR_ENTRY_GLOBAL_DAILY: 0 } });
    await hold(ACCOUNT, WAD);
    for (let i = 0; i < 10; i++) expect((await t.call("sell", { account: ACCOUNT, tokens: String(WAD) }, `192.0.2.${i + 1}`)).json.sponsored).toBe(true);
    expect(await grants()).toBe(1);
    const other = addr(0xa0001);
    registerAccount(t, other, addr(0xa0002));
    await hold(other, WAD);
    expect((await t.call("sell", { account: other, tokens: String(WAD) }, "192.0.2.77")).json.sponsored).toBe(true);
  });

  test("R3-05: a signature counts for the whole day, relayed through this API or not, and the relay books nothing more", async () => {
    const t = build({ limits: { SPONSOR_ENTRY_PER_ACCOUNT_DAILY: 2 } });
    fund(t, ACCOUNT, 500);
    const first = await t.call("buy", { account: ACCOUNT });
    expect(first.json.sponsored).toBe(true);
    await db.sql`update sponsorship_grants set expires_at = now() - interval '1 second'`; // the signature window has passed
    executed(t, ACCOUNT);
    const again = await t.call("buy", { account: ACCOUNT });
    expect(again.json.sponsored).toBe(true);
    expect(await relay(t, again.json)).toBe(200);
    expect(await grants()).toBe(2);
    executed(t, ACCOUNT);
    expect((await t.call("buy", { account: ACCOUNT })).json.sponsorship.reason).toBe("QUOTA_ACCOUNT");
  });

  test("R3-05 PoC: sponsored operations bundled outside the API (public bundler, direct handleOps) count against the global budget", async () => {
    // Report: build buys with sponsor=true from many accounts and networks, sign them, and submit them to EntryPoint.handleOps
    // yourself. They used to be invisible to QUOTA_GLOBAL (counted at relay time), so the paymaster's on-chain cap ran out.
    const limit = 25;
    const t = build({ limits: { SPONSOR_ENTRY_GLOBAL_DAILY: limit, SPONSOR_EXIT_GLOBAL_DAILY: 10 } });
    let signed = 0;
    for (let i = 0; i < 60; i++) {
      const account = addr(0xe0000 + (i % 6));
      registerAccount(t, account, addr(0xe1000 + (i % 6)));
      fund(t, account, 50);
      const { json } = await t.call("buy", { account }, `2001:db8:5:${i.toString(16)}::1`);
      if (json.sponsored) { signed += 1; executed(t, account); } // self-bundled: never sent to /v1/userop/send
      else expect(json.sponsorship.reason).toMatch(/QUOTA_GLOBAL|QUOTA_ACCOUNT/);
    }
    expect(await spends()).toBe(0);
    expect(signed).toBeLessThanOrEqual(limit);
    expect(await grants()).toBe(signed);
    // the exits' reserved share is untouched by every one of those entries
    const holder = addr(0xe2001);
    registerAccount(t, holder, addr(0xe2002));
    await hold(holder, WAD);
    expect((await t.call("sell", { account: holder, tokens: String(WAD) }, "192.0.2.200")).json.sponsored).toBe(true);
  });

  test("R3-05: only nonce lane 0 is sponsored", async () => {
    const t = build();
    fund(t, ACCOUNT, 100);
    const lane = (await t.call("buy", { account: ACCOUNT, nonceLane: 7 })).json;
    expect(lane.sponsored).toBe(false);
    expect(lane.sponsorship.reason).toBe("NONCE_LANE");
    expect(await grants()).toBe(0);
    expect((await t.call("buy", { account: ACCOUNT, nonceLane: 0 })).json.sponsored).toBe(true);
  });

  test("R3-05 variant PoC: strangers asking for 20 sponsored sells that name a holder's account leave the holder's own exit sponsored", async () => {
    const t = build();
    const victim = addr(0xf0001);
    registerAccount(t, victim, addr(0xf0002));
    await hold(victim, 5n * WAD);
    for (let i = 0; i < 40; i++) {
      // no signature is needed to ask; lanes other than 0 are not sponsored at all
      await t.call("sell", { account: victim, tokens: String(WAD), nonceLane: i % 3 === 0 ? 0 : i }, `2001:db8:66:${i.toString(16)}::1`);
    }
    expect(await grants()).toBe(1);
    const own = (await t.call("sell", { account: victim, tokens: String(WAD) }, "198.51.100.200")).json;
    expect(own.sponsored).toBe(true);
  });

  test("R3-05 PROPERTY: any sequence of entry ops (built, relayed, self-bundled or dropped) and strangers' requests naming A never deny A's sponsored exit, and the signer never signs more than the day's total", async () => {
    let seed = 5005;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let trial = 0; trial < 5; trial++) {
      await db.sql`truncate sponsorship_grants, balances`;
      const entryGlobal = 3 + rnd(10);
      const exitGlobal = 2 + rnd(4);
      const accountLimit = 3 + rnd(4);
      const t = build({ limits: {
        SPONSOR_ENTRY_GLOBAL_DAILY: entryGlobal, SPONSOR_EXIT_GLOBAL_DAILY: exitGlobal, SPONSOR_EXIT_PER_ACCOUNT_DAILY: accountLimit,
        SPONSOR_EXIT_PER_OWNER_DAILY: accountLimit, SPONSOR_ENTRY_PER_IP_DAILY: 1000, SPONSOR_EXIT_PER_IP_DAILY: 1000,
      } });
      const victim = addr(0x100000 + trial);
      registerAccount(t, victim, addr(0x110000 + trial));
      await hold(victim, 100n * WAD);
      fund(t, victim, 1000);
      let victimExits = 0;
      const attackerExits = rnd(2) === 1; // skeptic L3: half the trials add attackers' own self-bundled exits
      for (let step = 0; step < 80; step++) {
        const action = rnd(10);
        if (attackerExits && action === 0) {
          // an attacker's own sponsored exit from an account it funded with a position, self-bundled (a reverting sell still pays gas)
          const account = addr(0x140000 + trial * 1000 + rnd(40));
          registerAccount(t, account, addr(0x141000 + trial * 1000 + rnd(40)));
          await db.sql`insert into balances (token, account, balance, updated_block) values (${TOKEN}, ${account.toLowerCase()}, '5', 1) on conflict do nothing`;
          const { json } = await t.call("sell", { account, tokens: String(WAD) }, `2001:db8:e:${rnd(9000).toString(16)}::1`);
          if (json.sponsored) executed(t, account);
        } else if (action < 5) {
          // an attacker's entry: a fresh or reused account, any network, then self-bundled, relayed or dropped
          const account = addr(0x120000 + trial * 1000 + rnd(40));
          registerAccount(t, account, addr(0x130000 + trial * 1000 + rnd(40)));
          fund(t, account, 50);
          const { json } = await t.call(rnd(2) ? "buy" : "shield", { account }, `2001:db8:${rnd(9000).toString(16)}::1`);
          if (json.sponsored) {
            const fate = rnd(3);
            if (fate === 0) executed(t, account);
            else if (fate === 1) { await relay(t, json); executed(t, account); }
          }
        } else if (action < 8) {
          // a stranger names the victim (any kind, any lane, any network)
          const kind = (["buy", "sell", "shield"] as const)[rnd(3)]!;
          await t.call(kind, { account: victim, tokens: String(WAD), nonceLane: rnd(2) ? 0 : rnd(65_536) }, `198.51.100.${rnd(250)}`);
        } else if (victimExits < Math.min(accountLimit, exitGlobal) - 1) {
          // the victim's own exit, from its own network: always sponsored while it is inside its own limits
          const { json } = await t.call("sell", { account: victim, tokens: String(WAD) }, "203.0.113.250");
          if (json.sponsorship.granted) {
            executed(t, victim);
            victimExits += 1;
          } else {
            // L3, accepted: the only way the victim's exit is refused is QUOTA_GLOBAL after OTHER accounts' exits used the exit
            // share. Entries alone never cause it.
            expect(attackerExits).toBe(true);
            expect(json.sponsorship.reason).toBe("QUOTA_GLOBAL");
            const others = (await db.sql`select count(*)::int as n from sponsorship_grants where grp = 'exit' and account <> ${victim.toLowerCase()}`)[0]!.n as number;
            expect(others).toBeGreaterThanOrEqual(exitGlobal - victimExits - 1);
            victimExits = Number.MAX_SAFE_INTEGER; // the victim stops asking for today
          }
        }
        const totals = (await db.sql`select count(*) filter (where grp = 'entry')::int as entries, count(*) filter (where grp = 'exit')::int as exits from sponsorship_grants`)[0]!;
        expect(totals.entries).toBeLessThanOrEqual(entryGlobal);
        expect(totals.entries + totals.exits).toBeLessThanOrEqual(entryGlobal + exitGlobal);
      }
    }
  });

  /** R3-06 (H1): an owner key and its standard Kernel account (index 0), so the route's offline proof check can pass. */
  const STANDARD = { factory: KERNEL_V33_FACTORY as Address, validator: KERNEL_ECDSA_VALIDATOR as Address, implementation: KERNEL_V33_IMPLEMENTATION as Address };
  const ownerWithAccount = () => {
    const key = privateKeyToAccount(generatePrivateKey());
    return { key, account: predictKernelAddressOffline(STANDARD, key.address, 0) };
  };
  const proofFor = async (key: ReturnType<typeof privateKeyToAccount>, account: Address, expires = Math.floor(NOW_MS / 1000) + 600) =>
    ({ expires, signature: await key.signMessage({ message: sellLaneProofMessage(account, 4663, expires) }) });
  /** The production read budget with a clock the test moves; the flood of random accounts empties the shared lane. */
  const budgeted = (t: ReturnType<typeof build>) => {
    const clock = { at: 5_000_000 };
    (t.services as { chain: unknown }).chain = withRpcBudget(t.services.chain, { callsPerSecond: 5, burst: 14, now: () => clock.at });
    let n = 0;
    const flood = async (count: number) => {
      for (let i = 0; i < count; i++, n++) await t.call("sell", { account: addr(0x150000 + n), owner: addr(0x160000 + n), sponsor: false }, `2001:db8:77:${(n % 60000).toString(16)}::1`);
    };
    return { clock, flood };
  };

  test("R3-06 (route): the reserved read lane opens for a holder's own sell (position in Postgres and the owner's proof), not for any deployed Kernel account", async () => {
    const t = build();
    const { flood } = budgeted(t);
    const { key, account: holder } = ownerWithAccount();
    const kernel = addr(0x140002); // deployed through the public factory, no position
    registerAccount(t, holder, key.address);
    registerAccount(t, kernel, addr(0x140012));
    await hold(holder, WAD);
    await flood(40);
    expect((await t.call("sell", { account: kernel, tokens: String(WAD), sponsor: false }, "192.0.2.31")).status).toBe(503);
    const holderSell = await t.call("sell", { account: holder, tokens: String(WAD), sponsor: false, laneProof: await proofFor(key, holder) }, "192.0.2.32");
    expect(holderSell.status).toBe(200);
    expect(holderSell.json.userOp.sender).toBe(holder.toLowerCase());
  });

  test("R3-06 H1 (route): naming a holder's account without the owner's proof, with someone else's proof, or with an expired one does not open the lane", async () => {
    const t = build();
    const { flood } = budgeted(t);
    const { key, account: holder } = ownerWithAccount();
    const stranger = ownerWithAccount();
    registerAccount(t, holder, key.address);
    await hold(holder, WAD);
    await flood(40);
    const asks = [
      undefined,
      await proofFor(stranger.key, holder), // signed, but not by the owner of this account
      await proofFor(key, holder, Math.floor(NOW_MS / 1000) - 1), // expired
      await proofFor(key, holder, Math.floor(NOW_MS / 1000) + 3600), // longer than the 15 minutes a proof may last
      await proofFor(key, holder).then((p) => ({ ...p, expires: p.expires + 1 })), // not what was signed
    ];
    for (const laneProof of asks) {
      const response = await t.call("sell", { account: holder, tokens: String(WAD), sponsor: false, ...(laneProof ? { laneProof } : {}) }, "203.0.113.44");
      expect(response.status).toBe(503);
    }
    const own = await t.call("sell", { account: holder, tokens: String(WAD), sponsor: false, nonceLane: 3, laneProof: await proofFor(key, holder) }, "203.0.113.45");
    expect(own.status).toBe(503); // lane 0 only
    expect((await t.call("sell", { account: holder, tokens: String(WAD), sponsor: false, laneProof: await proofFor(key, holder) }, "203.0.113.46")).status).toBe(200);
  });

  test("R3-06 H1 PROPERTY (route, skeptic PoC): strangers naming any number of real holders' accounts on any lanes never stop a holder's own sell for more than 3 tries", async () => {
    let seed = 6116;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let trial = 0; trial < 3; trial++) {
      await db.sql`truncate balances`;
      const t = build();
      const { clock, flood } = budgeted(t);
      const victim = ownerWithAccount();
      registerAccount(t, victim.account, victim.key.address);
      await hold(victim.account, WAD);
      const named = Array.from({ length: 1 + rnd(40) }, (_, i) => addr(0x170000 + trial * 100 + i));
      for (const [i, a] of named.entries()) { registerAccount(t, a, addr(0x180000 + i)); await hold(a, WAD); }
      const second = async () => {
        clock.at += 1000;
        await flood(3);
        for (let k = 0; k < 2 + rnd(6); k++) {
          const lane = rnd(2) ? 0 : rnd(65_536);
          await t.call("sell", { account: named[rnd(named.length)], tokens: String(WAD), sponsor: rnd(2) === 0, nonceLane: lane }, `2001:db8:88:${rnd(4000).toString(16)}::1`);
        }
      };
      for (let s = 0; s < 20; s++) await second();
      for (let round = 0; round < 5; round++) {
        let served = false;
        for (let r = 0; r < 3 && !served; r++) {
          const response = await t.call("sell", { account: victim.account, tokens: String(WAD), sponsor: false, laneProof: await proofFor(victim.key, victim.account) }, "198.51.100.7");
          served = response.status === 200;
          if (!served) await second();
        }
        expect(served).toBe(true);
        for (let s = 0; s < 8; s++) await second();
      }
    }
  }, 120_000);

  test("skeptic L2: an exit grant at the same nonce is never reused for a buy once entry.global is full", async () => {
    const t = build({ limits: { SPONSOR_ENTRY_GLOBAL_DAILY: 1 } });
    const other = addr(0x190001);
    registerAccount(t, other, addr(0x190002));
    fund(t, other, 100);
    expect((await t.call("buy", { account: other })).json.sponsored).toBe(true); // the day's one entry
    fund(t, ACCOUNT, 100);
    await hold(ACCOUNT, WAD);
    expect((await t.call("sell", { account: ACCOUNT, tokens: String(WAD) })).json.sponsored).toBe(true); // an exit grant at ACCOUNT's nonce
    const buy = (await t.call("buy", { account: ACCOUNT })).json; // same account, same nonce, but a buy
    expect(buy.sponsored).toBe(false);
    expect(buy.sponsorship.reason).toBe("QUOTA_GLOBAL");
    expect((await t.call("sell", { account: ACCOUNT, tokens: String(WAD) })).json.sponsored).toBe(true); // the exit itself is still reused
  });

  test("skeptic L1: gifts into an owner's counterfactual accounts at other indices never use up the owner's primary account", async () => {
    const t = build();
    const owner = addr(0x1a0001);
    const primary = predictKernelAddressOffline(STANDARD, owner, 0);
    registerAccount(t, primary, owner);
    await hold(primary, WAD);
    // a stranger gifts about $1 of option tokens to the owner's predicted accounts at index 1..25 and books grants for them
    let booked = 0;
    for (let index = 1; index <= 25; index++) {
      const gifted = predictKernelAddressOffline(STANDARD, owner, index);
      await hold(gifted, WAD);
      t.state.predicted = gifted;
      const { json } = await t.call("sell", { account: gifted, owner, accountIndex: index, tokens: String(WAD) }, `2001:db8:99:${index.toString(16)}::1`);
      if (json.sponsored) booked += 1;
      else expect(json.sponsorship.reason).toBe("QUOTA_OWNER"); // the other accounts still share the owner quota
    }
    expect(booked).toBe(20);
    const own = (await t.call("sell", { account: primary, tokens: String(WAD) }, "198.51.100.30")).json;
    expect(own.sponsorship).toEqual({ requested: true, granted: true });
  });

  test("skeptic L4: the startup check warns when the sponsored totals x maxCostPerOp could exceed the paymaster's daily cap", () => {
    const limits = limitsFromConfig({});
    const ETH = 10n ** 18n;
    expect(sponsorshipCapWarning(limits, 2n * 10n ** 15n, undefined)).toBeUndefined(); // cap not configured: no check
    expect(sponsorshipCapWarning(limits, 2n * 10n ** 15n, ETH / 4n)).toContain("At most 125 worst-case operations fit");
    expect(sponsorshipCapWarning(limits, 10n ** 14n, ETH / 4n)).toBeUndefined(); // 2,500 x 1e14 = exactly 0.25 ETH
    let seed = 4004;
    const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
    for (let i = 0; i < 300; i++) {
      const entry = rnd(3000); const exit = rnd(3000);
      const custom = limitsFromConfig({ SPONSOR_ENTRY_GLOBAL_DAILY: entry, SPONSOR_EXIT_GLOBAL_DAILY: exit } as never);
      const perOp = BigInt(1 + rnd(1_000_000)) * 10n ** 9n; const cap = BigInt(1 + rnd(1_000_000)) * 10n ** 12n;
      // PROPERTY: silent exactly when the worst case fits under the cap
      expect(sponsorshipCapWarning(custom, perOp, cap) === undefined).toBe(BigInt(entry + exit) * perOp <= cap);
    }
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
    // (lane 0: R3-06 caps the fresh non-zero lanes one account may read to 4 a minute, and this one used 200)
    await buildUserOp(services, { account: ACCOUNT, calls: [{ to: ENGINE, value: 0n, data: "0x12345678" }], sponsor: false, nonceLane: 0 });
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
