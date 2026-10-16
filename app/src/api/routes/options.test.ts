import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decodeFunctionData } from "viem";
import { join } from "node:path";
import { pino } from "pino";
import { OptionEngineAbi } from "../../abi";
import { ADDR, testDeployment, b32 } from "../../indexer/test-support";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../../testing/db";
import { createApiApp } from "../app";
import { TtlCache } from "../cache";
import { QUOTE_PARAMS, quoteUnits } from "../quote/model";
import type { ApiDependencies } from "../types";

const suite = testDatabaseUrl() ? describe : describe.skip;
const ZERO = "0x0000000000000000000000000000000000000000";
const NVDA = ADDR.nvda;
const ALICE = ADDR.alice;
const NOW = Date.now();
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

// Series ids and tokens of the seeded NVDA grid.
const id = (n: number) => b32(0xa000 + n);
const token = (n: number) => `0x${(0x5000 + n).toString(16).padStart(40, "0")}`;
const GRID = [
  { n: 1, isCall: true, speed: "WEEKLY", strike: 200, buyable: true, archived: false },
  { n: 2, isCall: true, speed: "WEEKLY", strike: 220, buyable: true, archived: false },
  { n: 3, isCall: true, speed: "WEEKLY", strike: 240, buyable: true, archived: false },
  { n: 4, isCall: false, speed: "WEEKLY", strike: 200, buyable: true, archived: false },
  { n: 5, isCall: false, speed: "WEEKLY", strike: 220, buyable: true, archived: false },
  { n: 6, isCall: true, speed: "DAILY", strike: 220, buyable: true, archived: false },
  { n: 7, isCall: true, speed: "WEEKLY", strike: 150, buyable: false, archived: true },
] as const;

const logs: string[] = [];
let db: TestDatabase;
let deps: ApiDependencies;
let app: ReturnType<typeof createApiApp>;

async function setTick(session: string, fresh = true, buysPaused = false): Promise<void> {
  await db.sql`DELETE FROM ticks WHERE name = 'NVDA'`;
  await db.sql`INSERT INTO ticks (stock_token, name, ts, block, spot, session, fresh, buys_paused, price_updated_at)
    VALUES (${NVDA}, 'NVDA', ${at(0)}, 200, 220, ${session}, ${fresh}, ${buysPaused}, ${at(-60_000)})`;
}

function fresh(): ReturnType<typeof createApiApp> {
  deps = {
    sql: db.sql,
    config: { CORS_ORIGINS: ["https://app.example.test"], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet" },
    deployment: testDeployment(),
    logger: pino({ level: "info" }, { write: (line: string) => { logs.push(line); } }),
    cache: new TtlCache(),
  } as unknown as ApiDependencies;
  app = createApiApp(deps);
  return app;
}

const lower = (args: readonly unknown[] | undefined) => (args ?? []).map((a) => (typeof a === "string" ? a.toLowerCase() : a));
const get = (path: string) => app.request(path);
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

suite("option API over indexed data", () => {
  beforeAll(async () => {
    db = (await createTestDatabase("optionapi"))!;
    await applyMigrations(db);
    for (const row of GRID) {
      await db.sql`INSERT INTO series (id, stock_token, name, feed, is_call, speed, tau_s, strike, token, norm, last_accrual, buyable, archived, listed_at, listed_block, listed_tx, listed_log)
        VALUES (${id(row.n)}, ${NVDA}, 'NVDA', ${ADDR.nvdaFeed}, ${row.isCall}, ${row.speed}, ${row.speed === "DAILY" ? 86400 : 604800},
          ${row.strike}, ${token(row.n)}, 0.9, ${at(-3_600_000)}, ${row.buyable}, ${row.archived}, ${at(-86_400_000)}, 100, ${`0xlist${row.n}`}, ${row.n})`;
    }
    await setTick("REGULAR");
    for (const [index, speed] of (["DAILY", "WEEKLY"] as const).entries()) {
      await db.sql`INSERT INTO vol_posts (tx_hash, log_index, block, ts, stock_token, name, speed, sigma_bps, skew_k, event_bump_bps, valid_until, nonce)
        VALUES (${`0xvol${index}`}, 0, 150, ${at(-600_000)}, ${NVDA}, 'NVDA', ${speed}, ${speed === "DAILY" ? 5200 : 5000}, 0, 0, ${at(3_600_000)}, ${index + 1})`;
    }
    await db.sql`INSERT INTO pool_nav (ts, block, usdg, hedge_equity, option_liability, reserve, nav, nav_per_share)
      VALUES (${at(-30_000)}, 190, 1500000, 400000, 50000, 20000, 1850000, 1.04)`;
    await db.sql`INSERT INTO pool_nav (ts, block, usdg, hedge_equity, option_liability, reserve, nav, nav_per_share)
      VALUES (${at(-10 * 86_400_000)}, 100, 1500000, 400000, 50000, 20000, 1900000, 1.10)`;
    await db.sql`INSERT INTO limits_state (name, ts, block, stock_token, net_delta, net_gamma, net_vega, stress_loss_bps)
      VALUES ('NVDA', ${at(-30_000)}, 190, ${NVDA}, -120.5, 2.5, -40, 310.25)`;
    await db.sql`INSERT INTO hedge_equity_posts (tx_hash, log_index, block, ts, equity_usdg, as_of, ref)
      VALUES ('0xhedge', 0, 180, ${at(-1_800_000)}, 400000, ${at(-1_900_000)}, '0xref')`;
    await db.sql`INSERT INTO withdrawals (owner, ticket, shares, claimable_at, queued_at, queued_block, queued_tx, queued_log)
      VALUES (${ALICE}, 1, 5, ${at(86_400_000)}, ${at(-3_600_000)}, 170, '0xwd', 0)`;
    await db.sql`INSERT INTO queued_sells (ticket, series_id, seller, recipient, tokens, queued_at, queued_block, queued_tx, queued_log)
      VALUES (1, ${id(2)}, ${ALICE}, ${ALICE}, 1, ${at(-3_600_000)}, 171, '0xqs', 0)`;
    // Series 2 supply 100 tokens; alice holds 40, bob 60.
    await db.sql`INSERT INTO transfers (tx_hash, log_index, block, ts, series_id, token, from_addr, to_addr, amount) VALUES
      ('0xm1', 0, 120, ${at(-86_400_000)}, ${id(2)}, ${token(2)}, ${ZERO}, ${ALICE}, 100),
      ('0xm2', 0, 121, ${at(-80_000_000)}, ${id(2)}, ${token(2)}, ${ALICE}, ${ADDR.bob}, 60)`;
    await db.sql`INSERT INTO balances (token, account, balance, updated_block) VALUES
      (${token(2)}, ${ALICE}, 40, 121), (${token(2)}, ${ADDR.bob}, 60, 121)`;
    await db.sql`INSERT INTO trades (tx_hash, log_index, block, ts, series_id, account, recipient, side, units, shares, usdg, v_mark, sigma_bps, session)
      VALUES ('0xt1', 0, 120, ${at(-86_400_000)}, ${id(2)}, ${ALICE}, ${ALICE}, 'buy', 100, 100, 600, 5.5, 5000, 'REGULAR'),
             ('0xt2', 0, 121, ${at(-80_000_000)}, ${id(2)}, ${ALICE}, ${ALICE}, 'sell', 60, 60, 300, 5.0, 5000, 'REGULAR')`;
    await db.sql`INSERT INTO norm_history (series_id, ts, tx_hash, log_index, block, norm, v_mark, payoff, session) VALUES
      (${id(2)}, ${at(-2 * 86_400_000)}, '0xn1', 0, 110, 1, 5.6, 0, 'REGULAR'),
      (${id(2)}, ${at(-3_600_000)}, '0xn2', 0, 195, 0.9, 5.4, 0, 'REGULAR')`;
    fresh();
  });
  afterAll(async () => db.close());

  test("GET /v1/chains/NVDA: ordered strike grid per speed with bid, ask, daily cost, breakeven and Greeks (R1, R6)", async () => {
    await setTick("REGULAR");
    fresh();
    const response = await get("/v1/chains/nvda");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("public, max-age=2");
    const body = await response.json() as any;
    expect(body.name).toBe("NVDA");
    expect(body.spot).toBe("220");
    expect(body.session).toBe("REGULAR");
    expect(body.buyable).toBe(true);
    expect(body.speeds.map((s: any) => s.speed)).toEqual(["DAILY", "WEEKLY"]);
    const weekly = body.speeds[1];
    expect(weekly.strikes.map((row: any) => row.strike)).toEqual(["200", "220", "240"]);
    expect(weekly.volStale).toBe(false);
    expect(weekly.volAgeSeconds).toBeGreaterThanOrEqual(599);
    const atm = weekly.strikes[1];
    expect(atm.moneynessPct).toBe(0);
    expect(atm.call.id).toBe(id(2));
    expect(atm.put.id).toBe(id(5));
    expect(Number(atm.call.bid)).toBeLessThan(Number(atm.call.ask));
    expect(atm.call.displayCost).toMatch(/^costs about \$\d+\.\d\d\/day$/);
    expect(Number(atm.call.breakeven)).toBeGreaterThan(220);
    expect(Number(atm.put.breakeven)).toBeLessThan(220);
    expect(atm.call.delta).toBeGreaterThan(0.4);
    expect(atm.put.delta).toBeLessThan(-0.4);
    expect(atm.call.gamma).toBeGreaterThan(0);
    expect(atm.call.vega).toBeGreaterThan(0);
    expect(atm.call.buyable).toBe(true);
    expect(atm.call.blockReason).toBeNull();
    // the archived series is not on the chain and the 240 strike has no put
    expect(weekly.strikes[2].put).toBeNull();
    expect(JSON.stringify(body)).not.toContain(id(7));
    // Daily has only the one call
    expect(body.speeds[0].strikes).toHaveLength(1);
  });

  test("an unknown name is 404 and the chain is cached for two seconds", async () => {
    expect((await get("/v1/chains/ZZZZ")).status).toBe(404);
    expect((await get("/v1/chains/TSLA")).status).toBe(404); // known name, no price indexed yet
    fresh();
    const first = await (await get("/v1/chains/NVDA")).json() as any;
    await setTick("CLOSED");
    const cached = await (await get("/v1/chains/NVDA")).json() as any;
    expect(cached.session).toBe(first.session);
    fresh();
    const after = await (await get("/v1/chains/NVDA")).json() as any;
    expect(after.session).toBe("CLOSED");
    expect(after.buyable).toBe(false);
    expect(after.speeds[1].strikes[1].call.blockReason).toBe("SESSION_CLOSED");
    // bids and asks are still shown while buys are blocked
    expect(Number(after.speeds[1].strikes[1].call.bid)).toBeGreaterThan(0);
    await setTick("REGULAR");
    fresh();
  });

  test("GET /v1/chains lists listed names", async () => {
    const body = await (await get("/v1/chains")).json() as any;
    expect(body.names).toEqual([{ name: "NVDA", buyable: true }]);
  });

  test("POST /v1/quote returns the IOptionEngine.Quote fields and matches the model (R2)", async () => {
    const response = await post("/v1/quote", { series: id(2), units: "10", side: "buy" });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.unitsWad).toBe((10n * 10n ** 18n).toString());
    expect(Object.keys(body.quote).sort()).toEqual(
      ["breakevenWad", "buyable", "dailyCostUsdg", "feeUsdg", "session", "sigmaBps", "spreadBps", "usdg", "vMarkWad"]);
    expect(body.quote.buyable).toBe(true);
    expect(body.quote.sigmaBps).toBe("5000");
    expect(body.quote.session).toBe(0);
    // 3 bps of 220 x 10 units = 0.66
    expect(body.quote.feeUsdg).toBe("660000");
    const model = quoteUnits(
      { isCall: true, speed: "WEEKLY", strike: 220, buyable: true, archived: false },
      { spot: 220, session: "REGULAR", fresh: true, priceBuysPaused: false, engineBuysPaused: false, sigmaBps: 5000, volStale: false, buyBlockFromMs: null, buyBlockToMs: null, nowMs: NOW },
      10n * 10n ** 18n, true)!;
    expect(body.quote.usdg).toBe(model.usdg.toString());
    expect(body.display.usdg).toMatch(/^\d+\.\d{6}$/);
    const sell = await (await post("/v1/quote", { series: id(2), units: "10", side: "sell" })).json() as any;
    expect(BigInt(sell.quote.usdg)).toBeLessThan(BigInt(body.quote.usdg));
    expect(sell.blockReason).toBeNull();
  });

  test("POST /v1/quote validates input and reports unknown series", async () => {
    expect((await post("/v1/quote", { series: id(99), units: "1", side: "buy" })).status).toBe(404);
    expect((await post("/v1/quote", { series: "0x12", units: "1", side: "buy" })).status).toBe(400);
    expect((await post("/v1/quote", { series: id(2), units: "-1", side: "buy" })).status).toBe(400);
    expect((await post("/v1/quote", { series: id(2), units: "0", side: "buy" })).status).toBe(422);
    expect((await post("/v1/quote", { series: id(2), units: "1", side: "hold" })).status).toBe(400);
  });

  test("POST /v1/intent/buy returns decodable calldata, the USDG approval and a slippage buffer (R3)", async () => {
    const response = await post("/v1/intent/buy", { series: id(2), units: "10", account: ALICE, slippageBps: 100, deadlineSeconds: 120 });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.kind).toBe("buy");
    expect(body.to).toBe(ADDR.engine);
    expect(body.value).toBe("0");
    expect(body.approvals).toEqual([{ token: ADDR.usdg, spender: ADDR.engine, amount: body.maxCostUsdg }]);
    expect(BigInt(body.maxCostUsdg)).toBe((BigInt(body.quote.usdg) * 10_100n + 9_999n) / 10_000n);
    const decoded = decodeFunctionData({ abi: OptionEngineAbi, data: body.data });
    expect(decoded.functionName).toBe("buy");
    expect(lower(decoded.args)).toEqual([id(2), 10n * 10n ** 18n, BigInt(body.maxCostUsdg), BigInt(body.deadline), ALICE]);
    expect(Math.abs(body.deadline - (Math.floor(Date.now() / 1000) + 120))).toBeLessThanOrEqual(3);
    const other = await (await post("/v1/intent/buy", { series: id(2), units: "1", account: ALICE, recipient: ADDR.bob })).json() as any;
    expect(lower(decodeFunctionData({ abi: OptionEngineAbi, data: other.data }).args)[4]).toBe(ADDR.bob);
  });

  test("buy intents are refused with a reason when the session or the series blocks buys, and EXTENDED is allowed", async () => {
    await setTick("CLOSED");
    fresh();
    const closed = await post("/v1/intent/buy", { series: id(2), units: "1", account: ALICE });
    expect(closed.status).toBe(409);
    expect(await closed.json()).toMatchObject({ error: "BUY_BLOCKED", reason: "SESSION_CLOSED" });
    await setTick("EXTENDED");
    fresh();
    const extended = await post("/v1/intent/buy", { series: id(2), units: "1", account: ALICE });
    expect(extended.status).toBe(200);
    expect((await extended.json() as any).quote.session).toBe(1);
    await setTick("REGULAR", false);
    fresh();
    expect(await (await post("/v1/intent/buy", { series: id(2), units: "1", account: ALICE })).json()).toMatchObject({ reason: "PRICE_STALE" });
    await setTick("REGULAR", true, true);
    fresh();
    expect(await (await post("/v1/intent/buy", { series: id(2), units: "1", account: ALICE })).json()).toMatchObject({ reason: "PRICE_PAUSED" });
    await setTick("REGULAR");
    fresh();
    expect(await (await post("/v1/intent/buy", { series: id(7), units: "1", account: ALICE })).json()).toMatchObject({ reason: "SERIES_ARCHIVED" });
    const bigQuote = await post("/v1/intent/buy", { series: id(2), units: "0", account: ALICE });
    expect(bigQuote.status).toBe(422);
  });

  test("an earnings block window and a global engine pause both block buys", async () => {
    await db.sql`UPDATE vol_posts SET buy_block_from = ${at(-3_600_000)}, buy_block_to = ${at(3_600_000)} WHERE speed = 'WEEKLY'`;
    fresh();
    expect(await (await post("/v1/intent/buy", { series: id(2), units: "1", account: ALICE })).json()).toMatchObject({ reason: "EARNINGS_BLOCK" });
    // sells are never blocked by it
    expect((await post("/v1/intent/sell", { series: id(2), units: "1", account: ALICE })).status).toBe(200);
    await db.sql`UPDATE vol_posts SET buy_block_from = NULL, buy_block_to = NULL`;
    await db.sql`INSERT INTO pause_log (tx_hash, log_index, block, ts, scope, key, paused, reason) VALUES ('0xp1', 0, 300, ${at(-1000)}, 'global', 'all', true, NULL)`;
    fresh();
    expect(await (await post("/v1/intent/buy", { series: id(2), units: "1", account: ALICE })).json()).toMatchObject({ reason: "BUYS_PAUSED" });
    expect((await post("/v1/intent/sell", { series: id(2), units: "1", account: ALICE })).status).toBe(200);
    await db.sql`INSERT INTO pause_log (tx_hash, log_index, block, ts, scope, key, paused, reason) VALUES ('0xp2', 0, 301, ${at(-500)}, 'global', 'all', false, NULL)`;
    fresh();
    expect((await post("/v1/intent/buy", { series: id(2), units: "1", account: ALICE })).status).toBe(200);
  });

  test("sell intents always return calldata; the token amount accounts for the funding factor; HALTED queues (R3)", async () => {
    const sell = await post("/v1/intent/sell", { series: id(2), units: "9", account: ALICE, slippageBps: 50 });
    expect(sell.status).toBe(200);
    const body = await sell.json() as any;
    expect(body.approvals).toEqual([]);
    expect(body.queued).toBe(false);
    // norm is 0.9, so 9 units are 10 tokens
    expect(body.tokens).toBe((10n * 10n ** 18n).toString());
    expect(BigInt(body.minProceedsUsdg)).toBe((BigInt(body.quote.usdg) * 9_950n) / 10_000n);
    const decoded = decodeFunctionData({ abi: OptionEngineAbi, data: body.data });
    expect(decoded.functionName).toBe("sell");
    expect(lower(decoded.args)[1]).toBe(10n * 10n ** 18n);

    await setTick("CLOSED");
    fresh();
    const closed = await (await post("/v1/intent/sell", { series: id(2), units: "9", account: ALICE })).json() as any;
    expect(closed.queued).toBe(false);
    expect(closed.note).toContain("last close");
    expect(BigInt(closed.minProceedsUsdg)).toBeGreaterThan(0n);

    await setTick("HALTED");
    fresh();
    const halted = await post("/v1/intent/sell", { series: id(2), units: "9", account: ALICE });
    expect(halted.status).toBe(200);
    const queued = await halted.json() as any;
    expect(queued.queued).toBe(true);
    expect(queued.minProceedsUsdg).toBe("0");
    expect(queued.note).toContain("queue");
    await setTick("REGULAR");
    fresh();
  });

  test("POST /v1/intent/shield picks the Weekly put nearest the protection level and prices it (R3)", async () => {
    const response = await post("/v1/intent/shield", { name: "nvda", tokenUnits: "5", account: ALICE, strikePctBelowBps: 1000 });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    // target 198: the 200 put is nearest
    expect(body.series).toBe(id(4));
    const decoded = decodeFunctionData({ abi: OptionEngineAbi, data: body.data });
    expect(decoded.functionName).toBe("shield");
    const pct = Number(decoded.args[2]);
    expect(lower(decoded.args)).toEqual([NVDA, 5n * 10n ** 18n, pct, BigInt(body.maxCostUsdg), BigInt(body.deadline)]);
    // todo 23 fork bug: the engine buys the LARGEST buyable Weekly put <= S x (1 - pct) (EngineTradeLib.pickShield).
    // The calldata must make that rule land on the strike the API quoted (200), not on nothing (pct 1000 -> 198).
    const engineTarget = 220 * (10_000 - pct) / 10_000;
    const enginePick = [200, 220].filter((k) => k <= engineTarget).at(-1);
    expect(enginePick).toBe(200);
    // and it still lands there if the price moves 0.5% either way before the transaction is mined
    for (const s of [220 * 0.995, 220 * 1.005]) expect([200, 220].filter((k) => k <= s * (10_000 - pct) / 10_000).at(-1)).toBe(200);
    expect(body.approvals[0].token).toBe(ADDR.usdg);
    expect((await post("/v1/intent/shield", { name: "ZZZZ", tokenUnits: "5", account: ALICE })).status).toBe(404);
    await setTick("CLOSED");
    fresh();
    expect(await (await post("/v1/intent/shield", { name: "NVDA", tokenUnits: "5", account: ALICE })).json()).toMatchObject({ reason: "SESSION_CLOSED" });
    await setTick("REGULAR");
    fresh();
  });

  test("GET /v1/pool: NAV, exposures, stress, caps usage, hedge age, drawdown and queue (R4)", async () => {
    const response = await get("/v1/pool");
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.nav).toBe("1850000");
    expect(body.navPerShare).toBe("1.04");
    expect(body.hedgeEquity).toBe("400000");
    expect(body.optionLiability).toBe("50000");
    expect(body.exposures.map((row: any) => row.name)).toEqual(["NVDA", "TSLA"]);
    const nvda = body.exposures[0];
    expect(nvda.netDelta).toBe("-120.5");
    expect(Number(nvda.deltaNotionalUsdg)).toBeCloseTo(-120.5 * 220, 4);
    expect(nvda.stressLossBps).toBe("310.25");
    // series 2 holds 100 tokens x norm 0.9 = 90 units of a weekly 220 call, marked near 5.4
    expect(Number(nvda.outstandingValueUsdg)).toBeGreaterThan(300);
    expect(Number(nvda.outstandingValueUsdg)).toBeLessThan(900);
    expect(body.stressLossBps).toBe("310.2500");
    expect(body.caps.navCapUsdg).toBe("2000000");
    expect(body.caps.totalOptionValueCapPct).toBe(35);
    expect(body.caps.perNameCapPct).toBe(8);
    expect(body.caps.perSeriesCapUsdg).toBe("40000");
    expect(body.hedgeEquityAgeSeconds).toBeGreaterThanOrEqual(1899);
    expect(body.hedgeEquityAgeSeconds).toBeLessThan(2100);
    // peak 1.10 over 30d vs 1.04 now
    expect(body.drawdown30dPct).toBeCloseTo(((1.1 - 1.04) / 1.1) * 100, 3);
    expect(body.queue).toEqual({ withdrawals: 1, withdrawalShares: "5", sells: 1 });
    expect(body.fundingReceived.windowHours).toBe(24);
    // norm fell from 1 (2 days ago) to 0.9 on 100 tokens, marked at 5.4
    expect(Number(body.fundingReceived.usdg)).toBeCloseTo(100 * 0.1 * 5.4, 4);
    expect(body.buysPaused).toBe(false);
  });

  test("GET /v1/vol/NVDA: sigma inputs, posts with expiry, history; unknown names 404 (R5)", async () => {
    const body = await (await get("/v1/vol/NVDA")).json() as any;
    expect(body.speeds.map((s: any) => s.speed)).toEqual(["DAILY", "WEEKLY"]);
    expect(body.speeds[1].latest.sigmaBps).toBe(5000);
    expect(body.speeds[1].latest.stale).toBe(false);
    expect(body.speeds[1].latest.secondsToExpiry).toBeGreaterThan(3500);
    expect(body.speeds[0].latest.sigmaBps).toBe(5200);
    expect(body.history).toHaveLength(2);
    expect(body.spot).toBe("220");
    expect((await get("/v1/vol/NOPE")).status).toBe(404);
  });

  test("GET /v1/accounts/{address}/positions: units, value at bid, cost, cost basis and P&L (R5, R6)", async () => {
    const response = await get(`/v1/accounts/${ALICE.toUpperCase().replace("0X", "0x")}/positions`);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const body = await response.json() as any;
    expect(body.account).toBe(ALICE);
    expect(body.positions).toHaveLength(1);
    const position = body.positions[0];
    expect(position.seriesId).toBe(id(2));
    expect(position.balance).toBe("40");
    expect(position.units).toBe("36");
    expect(position.costBasisUsdg).toBe("600.000000");
    expect(position.proceedsUsdg).toBe("300.000000");
    const sell = await (await post("/v1/quote", { series: id(2), units: "36", side: "sell" })).json() as any;
    expect(position.valueAtBidUsdg).toBe(sell.display.usdg);
    expect(position.dailyCostUsdg).toBe(sell.display.dailyCostUsdg);
    expect(position.displayCost).toMatch(/^costs (about|less than)/);
    expect(Number(position.pnlUsdg)).toBeCloseTo(Number(position.valueAtBidUsdg) + 300 - 600, 5);
    expect(body.totals.valueAtBidUsdg).toBe(position.valueAtBidUsdg);
    expect(body.queuedSells).toHaveLength(1);
    const empty = await (await get(`/v1/accounts/${ADDR.carol}/positions`)).json() as any;
    expect(empty.positions).toEqual([]);
    expect(empty.totals.valueAtBidUsdg).toBe("0.000000");
    expect((await get("/v1/accounts/0x123/positions")).status).toBe(400);
  });

  test("GET /v1/series/{id}: terms, funding history and a priced option", async () => {
    const body = await (await get(`/v1/series/${id(2)}?history=10`)).json() as any;
    expect(body.id).toBe(id(2));
    expect(body.strike).toBe("220");
    expect(body.norm).toBe("0.9");
    expect(body.normHistory.map((p: any) => p.norm)).toEqual(["0.9", "1"]);
    expect(body.option.id).toBe(id(2));
    expect((await get(`/v1/series/${id(99)}`)).status).toBe(404);
  });

  test("GET /v1/config: addresses, names, caps and pricing constants (R5)", async () => {
    const body = await (await get("/v1/config")).json() as any;
    expect(body.chainId).toBe(4663);
    expect(body.contracts.engine).toBe(ADDR.engine);
    expect(body.names).toEqual(["NVDA", "TSLA"]);
    expect(body.usdgDecimals).toBe(6);
    expect(body.caps.poolNavUsdg).toBe("2000000");
    expect(body.caps.writerVaultsOpen).toBe(false);
    expect(body.pricing.feeBps).toBe(QUOTE_PARAMS.feeBps);
  });

  test("/v1/health still answers", async () => {
    expect((await get("/v1/health")).status).toBe(200);
  });

  test("/v1/openapi.json is a valid 3.1 document listing every route with a response schema (R7)", async () => {
    const document = await (await get("/v1/openapi.json")).json() as any;
    expect(document.openapi).toBe("3.1.0");
    for (const [path, method] of [
      ["/v1/chains", "get"], ["/v1/chains/{name}", "get"], ["/v1/series/{id}", "get"], ["/v1/quote", "post"],
      ["/v1/intent/buy", "post"], ["/v1/intent/sell", "post"], ["/v1/intent/shield", "post"], ["/v1/pool", "get"],
      ["/v1/vol/{name}", "get"], ["/v1/accounts/{address}/positions", "get"], ["/v1/config", "get"], ["/v1/health", "get"],
    ] as const) {
      const schema = document.paths?.[path]?.[method]?.responses?.["200"]?.content?.["application/json"]?.schema;
      expect(schema, `${method} ${path}`).toBeDefined();
    }
    expect(document.paths["/v1/openapi.json"]).toBeUndefined();
  });

  test("no copy-rule words in any response (R4, copy rules)", async () => {
    await setTick("REGULAR");
    fresh();
    const bodies = await Promise.all([
      get("/v1/chains/NVDA"), get("/v1/pool"), get("/v1/vol/NVDA"), get("/v1/config"), get(`/v1/accounts/${ALICE}/positions`),
      get(`/v1/series/${id(2)}`), post("/v1/quote", { series: id(2), units: "1", side: "buy" }),
      post("/v1/intent/buy", { series: id(2), units: "1", account: ALICE }),
      post("/v1/intent/sell", { series: id(2), units: "1", account: ALICE }),
      post("/v1/intent/shield", { name: "NVDA", tokenUnits: "1", account: ALICE }),
    ].map(async (promise) => (await promise).text()));
    const banned = /\b(apy|apr|yield|yields|income|free|guaranteed|risk-free)\b|can't lose|can’t lose|no fees|no time decay|partnership|endorse/i;
    for (const text of bodies) expect(text).not.toMatch(banned);
    expect(bodies.join("")).not.toContain("APY");
  });

  test("request logs carry the route pattern, never an account address (R8)", async () => {
    logs.length = 0;
    await get(`/v1/accounts/${ALICE}/positions`);
    await post("/v1/intent/buy", { series: id(2), units: "1", account: ALICE });
    const text = logs.join("\n");
    expect(text).toContain("/v1/accounts/:address/positions");
    expect(text.toLowerCase()).not.toContain(ALICE.toLowerCase());
    expect(text.toLowerCase()).not.toContain(id(2).toLowerCase());
  });

  test("CORS allows the configured origin only; quote and intent bodies are size limited (R8)", async () => {
    const allowed = await app.request("/v1/pool", { headers: { origin: "https://app.example.test" } });
    expect(allowed.headers.get("access-control-allow-origin")).toBe("https://app.example.test");
    const denied = await app.request("/v1/pool", { headers: { origin: "https://evil.example.test" } });
    expect(denied.headers.get("access-control-allow-origin") ?? "").toBe("");
    const huge = await app.request("/v1/quote", {
      method: "POST", headers: { "content-type": "application/json", "content-length": "9000" }, body: JSON.stringify({ pad: "x".repeat(9000) }),
    });
    expect(huge.status).toBe(413);
  });

  test("bun run smoke passes against a running server (R7)", async () => {
    await setTick("REGULAR");
    fresh();
    const server = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: app.fetch });
    try {
      const child = Bun.spawn(["bun", "run", "scripts/smoke.ts", `http://127.0.0.1:${server.port}`], {
        cwd: join(import.meta.dir, "../../.."), stdout: "pipe", stderr: "pipe", env: { ...process.env, SMOKE_ADDRESS: ALICE },
      });
      const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      expect(err + out).toContain("API smoke passed");
      expect(code).toBe(0);
    } finally {
      await server.stop(true);
    }
  });
});
