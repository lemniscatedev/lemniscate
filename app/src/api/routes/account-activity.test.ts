import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pino } from "pino";
import { ADDR, FakeChain, FakeReader, SERIES_CALL, SERIES_PUT, makeIndexer, syncToHead, testDeployment, ev, a } from "../../indexer/test-support";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../../testing/db";
import { createApiApp } from "../app";
import { TtlCache } from "../cache";
import type { ApiDependencies } from "../types";
import { predictKernelAddressOffline } from "../../aa/counterfactual";
import { KERNEL_ECDSA_VALIDATOR, KERNEL_V33_FACTORY } from "../../aa/config";
import { KERNEL_V33_IMPLEMENTATION } from "../../aa/counterfactual";

const suite = testDatabaseUrl() ? describe : describe.skip;
const WAD = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const OTHER_AGENT = a(0xa6e48);
const FAR = 4_102_444_800n; // 2100
const PAST = 1_000_000_000n; // 2001

let db: TestDatabase;
let app: ReturnType<typeof createApiApp>;
let testDeps: ApiDependencies;
const get = (path: string) => app.request(path);

suite("account activity, agents and smart account (todo 15b)", () => {
  beforeAll(async () => {
    db = (await createTestDatabase("acctact"))!;
    await applyMigrations(db);
    const chain = new FakeChain();
    chain.mine([
      ev.seriesListed(SERIES_CALL, ADDR.nvda, true, 1, 110n * WAD, ADDR.tokenCall),
      ev.seriesListed(SERIES_PUT, ADDR.nvda, false, 0, 90n * WAD, ADDR.tokenPut),
    ]);
    chain.mine([ev.buyableSet(SERIES_CALL, true), ev.buyableSet(SERIES_PUT, true)]);
    chain.mine([
      ev.transfer(ADDR.tokenCall, ZERO, ADDR.alice, 4n * WAD),
      ev.bought(SERIES_CALL, ADDR.alice, ADDR.alice, 4n * WAD, 4n * WAD, 10_000_000n, 2_500_000_000_000_000_000n),
    ]);
    chain.mine([ev.sold(SERIES_CALL, ADDR.alice, ADDR.alice, WAD, WAD, 2_000_000n, 2_000_000_000_000_000_000n)]);
    chain.mine([
      ev.sellQueued(1n, SERIES_PUT, ADDR.alice, ADDR.alice, WAD, 1_790_000_100n),
      ev.sellQueued(2n, SERIES_PUT, ADDR.alice, ADDR.alice, 2n * WAD, 1_790_000_101n),
      ev.sellQueued(3n, SERIES_PUT, ADDR.bob, ADDR.bob, WAD, 1_790_000_102n),
    ]);
    chain.mine([ev.queuedFilled(1n, ADDR.carol, 2_000_000n), ev.queuedCancelled(2n)]);
    chain.mine([
      ev.poolDeposit(ADDR.alice, ADDR.alice, 100_000_000n, 100n * 10n ** 12n),
      ev.withdrawalQueued(ADDR.alice, 1n, 40n * 10n ** 12n, 1_790_259_200n),
    ]);
    chain.mine([ev.withdrawalClaimed(ADDR.alice, 1n, 41_000_000n), ev.poolWithdraw(ADDR.alice, ADDR.alice, ADDR.alice, 41_000_000n, 40n * 10n ** 12n)]);
    chain.mine([
      ev.policySet(ADDR.alice, ADDR.agent, 50_000_000n, 20_000_000n, FAR, true, false),
      ev.policySet(ADDR.alice, OTHER_AGENT, 30_000_000n, 30_000_000n, PAST, false, false),
      ev.policySet(ADDR.bob, ADDR.agent, 99_000_000n, 99_000_000n, FAR, true, true),
    ]);
    chain.mine([
      ev.agentTrade(ADDR.alice, ADDR.agent, SERIES_CALL, true, 5_000_000n),
      ev.agentTrade(ADDR.alice, ADDR.agent, SERIES_CALL, false, 1_000_000n),
      ev.agentTrade(ADDR.alice, OTHER_AGENT, SERIES_PUT, true, 2_000_000n),
    ]);
    chain.mine([ev.policySet(ADDR.alice, ADDR.agent, 60_000_000n, 25_000_000n, FAR, true, true)]);
    chain.mine([ev.policyRevoked(ADDR.alice, OTHER_AGENT)]);
    // 17b: PolicyStocks replaces the list on every setPolicy; a router sell is queued by the engine with the router as seller.
    chain.mine([
      ev.policyStocks(ADDR.alice, ADDR.agent, [ADDR.nvda]),
      ev.policyStocks(ADDR.alice, OTHER_AGENT, [ADDR.nvda]),
      ev.policyStocks(ADDR.bob, ADDR.agent, [ADDR.nvda]),
    ]);
    chain.mine([ev.policyStocks(ADDR.alice, ADDR.agent, [ADDR.nvda, ADDR.tsla])]);
    chain.mine([
      ev.sellQueued(9n, SERIES_CALL, ADDR.agentRouter, ADDR.agentRouter, WAD, 1_790_000_200n),
      ev.queuedSellFor(9n, ADDR.alice, ADDR.agent, SERIES_CALL),
    ]);
    const reader = new FakeReader();
    reader.series[SERIES_CALL] = { norm: WAD, lastAccrual: 1_790_000_000n };
    const { state } = await makeIndexer(db.sql, chain, { reader });
    await syncToHead(state);
    await db.sql`INSERT INTO shields (tx_hash, log_index, block, ts, account, stock_token, series_id, token_units, usdg_paid)
      VALUES ('0xshield', 0, 3, now() - interval '1 day', ${ADDR.alice}, ${ADDR.nvda}, ${SERIES_PUT}, 2, 1.5)`;
    const deps = {
      sql: db.sql,
      config: { CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet" },
      deployment: testDeployment(), logger: pino({ level: "silent" }), cache: new TtlCache(),
    } as unknown as ApiDependencies;
    testDeps = deps;
    app = createApiApp(deps);
  });
  afterAll(async () => db.close());

  test("activity lists every kind, newest first, for one account only", async () => {
    const response = await get(`/v1/accounts/${ADDR.alice}/activity?limit=200`);
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    const kinds = body.items.map((item: any) => item.kind);
    expect(new Set(kinds)).toEqual(new Set([
      "buy", "sell", "shield", "sell_queued", "sell_filled", "sell_cancelled", "pool_deposit", "pool_withdraw",
      "withdraw_requested", "withdraw_claimed", "agent_buy", "agent_sell",
    ]));
    const times = body.items.map((item: any) => Date.parse(item.ts));
    expect([...times].sort((x: number, y: number) => y - x)).toEqual(times);
    expect(body.items.filter((item: any) => item.kind === "sell_queued")).toHaveLength(3); // alice two own plus one router ticket; bob ticket is not hers
    expect(body.nextCursor).toBeNull();
    const buy = body.items.find((item: any) => item.kind === "buy");
    expect(buy).toMatchObject({ name: "NVDA", isCall: true, speed: "WEEKLY", strike: "110", usdg: "10", amount: "4", seriesId: SERIES_CALL });
    const filled = body.items.find((item: any) => item.kind === "sell_filled");
    expect(filled).toMatchObject({ ticket: "1", usdg: "2", filler: ADDR.carol, status: "filled" });
    expect(body.items.find((item: any) => item.kind === "sell_cancelled")).toMatchObject({ ticket: "2", status: "cancelled" });
    expect(body.items.find((item: any) => item.kind === "withdraw_claimed")).toMatchObject({ usdg: "41", ticket: "1" });
    expect(body.items.find((item: any) => item.kind === "agent_buy")).toMatchObject({ agent: ADDR.agent, usdg: "5" });
  });

  test("cursor pages cover every row once with no overlap", async () => {
    const all = await (await get(`/v1/accounts/${ADDR.alice}/activity?limit=200`)).json() as any;
    const seen: string[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const response = await get(`/v1/accounts/${ADDR.alice}/activity?limit=4${cursor ? `&cursor=${cursor}` : ""}`);
      const page = await response.json() as any;
      expect(page.items.length).toBeLessThanOrEqual(4);
      for (const item of page.items) seen.push(`${item.txHash}:${item.logIndex}:${item.kind}`);
      cursor = page.nextCursor;
      pages += 1;
    } while (cursor && pages < 20);
    expect(seen).toEqual(all.items.map((item: any) => `${item.txHash}:${item.logIndex}:${item.kind}`));
    expect(new Set(seen).size).toBe(seen.length);
    expect(pages).toBeGreaterThan(2);
  });

  test("a bad cursor is 400, an unknown account has an empty feed", async () => {
    expect((await get(`/v1/accounts/${ADDR.alice}/activity?cursor=nonsense`)).status).toBe(400);
    const empty = await (await get(`/v1/accounts/${a(0xdead)}/activity`)).json() as any;
    expect(empty.items).toEqual([]);
    expect(empty.nextCursor).toBeNull();
  });

  test("agents: newest policy wins, revoked and expired are flagged, spend comes from indexed agent buys", async () => {
    const body = await (await get(`/v1/accounts/${ADDR.alice}/agents`)).json() as any;
    expect(body.agents).toHaveLength(2); // bob's policy is not alice's
    const main = body.agents.find((row: any) => row.agent === ADDR.agent);
    expect(main).toMatchObject({
      budgetUsdg: "60", maxPerTradeUsdg: "25", spentUsdg: "5", remainingBudgetUsdg: "55", canSell: true, canShield: true,
      revoked: false, expired: false, active: true, tradeCount: 2,
    });
    expect(main.recentTrades.map((trade: any) => trade.side).sort()).toEqual(["buy", "sell"]);
    expect(main.recentTrades[0]).toMatchObject({ name: "NVDA", agent: ADDR.agent });
    const other = body.agents.find((row: any) => row.agent === OTHER_AGENT);
    expect(other).toMatchObject({ revoked: true, expired: true, active: false, spentUsdg: "2", remainingBudgetUsdg: "28", tradeCount: 1 });
    expect(other.revokedAt).not.toBeNull();
  });

  test("agents: allowedStocks is the newest PolicyStocks list, named from the indexed series", async () => {
    const body = await (await get(`/v1/accounts/${ADDR.alice}/agents`)).json() as any;
    const main = body.agents.find((row: any) => row.agent === ADDR.agent);
    expect(main.allowedStocks.map((row: any) => row.stock)).toEqual([ADDR.nvda, ADDR.tsla]);
    expect(main.allowedStocks[0]).toEqual({ stock: ADDR.nvda, name: "NVDA" });
    expect(body.agents.find((row: any) => row.agent === OTHER_AGENT).allowedStocks).toHaveLength(1);
    const bob = await (await get(`/v1/accounts/${ADDR.bob}/agents`)).json() as any;
    expect(bob.agents[0].allowedStocks.map((row: any) => row.stock)).toEqual([ADDR.nvda]);
  });

  test("activity: a router-queued sell shows for the owner (with the agent), not for the router or a stranger", async () => {
    const mine = await (await get(`/v1/accounts/${ADDR.alice}/activity?limit=200`)).json() as any;
    const queued = mine.items.filter((item: any) => item.ticket === "9");
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ kind: "sell_queued", agent: ADDR.agent, status: "open", seriesId: SERIES_CALL });
    const bob = await (await get(`/v1/accounts/${ADDR.bob}/activity?limit=200`)).json() as any;
    expect(bob.items.some((item: any) => item.ticket === "9")).toBe(false);
  });

  test("a policy set again after a revoke is live again", async () => {
    await db.sql`INSERT INTO agent_policy_events (tx_hash, log_index, block, ts, kind, owner, agent, budget_usdg, max_per_trade_usdg, expires_at, can_sell, can_shield)
      VALUES ('0xre', 0, 9999, now(), 'set', ${ADDR.alice}, ${OTHER_AGENT}, 10, 10, '2100-01-01', true, true)`;
    const body = await (await get(`/v1/accounts/${ADDR.alice}/agents`)).json() as any;
    expect(body.agents.find((row: any) => row.agent === OTHER_AGENT)).toMatchObject({ revoked: false, active: true, budgetUsdg: "10" });
  });

  test("smart account: the counterfactual Kernel address, no RPC, deployed once the indexer has seen it", async () => {
    const expected = predictKernelAddressOffline(
      { factory: KERNEL_V33_FACTORY as `0x${string}`, validator: KERNEL_ECDSA_VALIDATOR as `0x${string}`, implementation: KERNEL_V33_IMPLEMENTATION as `0x${string}` },
      ADDR.alice, 0,
    ).toLowerCase();
    const first = await (await get(`/v1/accounts/${ADDR.alice}/smart-account`)).json() as any;
    expect(first).toMatchObject({ owner: ADDR.alice, accountIndex: 0, address: expected, deployed: null, chainId: 4663 });
    expect(first.factory).toBe(KERNEL_V33_FACTORY.toLowerCase());
    await db.sql`INSERT INTO account_metadata (address, first_seen_block, first_seen_at, last_seen_block, last_activity_at) VALUES (${expected}, 1, now(), 1, now())`;
    expect((await (await get(`/v1/accounts/${ADDR.alice}/smart-account`)).json() as any).deployed).toBe(true);
    const other = await (await get(`/v1/accounts/${ADDR.alice}/smart-account?index=1`)).json() as any;
    expect(other.address).not.toBe(expected);
    expect((await get(`/v1/accounts/${ADDR.alice}/smart-account?index=-1`)).status).toBe(400);
  });

  test("F33: the smart-account route never touches the paymaster keystore, so a broken or slow keystore cannot affect it", async () => {
    const saved = { ks: process.env.PAYMASTER_SIGNER_KEYSTORE, pw: process.env.PAYMASTER_SIGNER_KEYSTORE_PASSWORD_FILE };
    process.env.PAYMASTER_SIGNER_KEYSTORE = "/nonexistent/paymaster-keystore.json";
    process.env.PAYMASTER_SIGNER_KEYSTORE_PASSWORD_FILE = "/nonexistent/password";
    try {
      const fresh = createApiApp(testDeps); // a fresh app: nothing is cached yet
      const response = await fresh.request(`/v1/accounts/${ADDR.alice}/smart-account`);
      expect(response.status).toBe(200);
      expect(((await response.json()) as any).owner).toBe(ADDR.alice);
    } finally {
      if (saved.ks === undefined) delete process.env.PAYMASTER_SIGNER_KEYSTORE; else process.env.PAYMASTER_SIGNER_KEYSTORE = saved.ks;
      if (saved.pw === undefined) delete process.env.PAYMASTER_SIGNER_KEYSTORE_PASSWORD_FILE; else process.env.PAYMASTER_SIGNER_KEYSTORE_PASSWORD_FILE = saved.pw;
    }
  });

  test("OpenAPI lists the three routes", async () => {
    const doc = await (await get("/v1/openapi.json")).json() as any;
    for (const path of ["activity", "agents", "smart-account"]) expect(doc.paths[`/v1/accounts/{address}/${path}`]).toBeDefined();
  });
});
