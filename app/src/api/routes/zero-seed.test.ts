// Zero-seed launch: the Writer Pool starts EMPTY (the owner and team deposit nothing) and fills from the public.
// These tests run the API over a fake indexer history: an empty pool, a tiny pool, and writers' deposits and exits.
import { afterAll, beforeAll, describe, expect, setSystemTime, test } from "bun:test";
import { pino } from "pino";
import { ADDR, testDeployment, b32 } from "../../indexer/test-support";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../../testing/db";
import { createApiApp } from "../app";
import { TtlCache } from "../cache";
import type { ApiDependencies } from "../types";
import { writerRewards, weeklyPoolUnits, type WriterRewardsConfig } from "../../config/writer-rewards";
import { buildWeek } from "../../rewards/writer-week";
import { weekBasis } from "./writers";

const suite = testDatabaseUrl() ? describe : describe.skip;
const NVDA = ADDR.nvda;
const ZERO = "0x0000000000000000000000000000000000000000";
const POOL = ADDR.pool.toLowerCase();
const OWNER = writerRewards.projectWallets.owner!.toLowerCase();
const NOW = Date.parse("2026-11-04T15:00:00.000Z"); // a Wednesday, inside regular hours
const DAY = 86_400_000;
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();
const id = (n: number) => b32(0xb000 + n);
const token = (n: number) => `0x${(0x6000 + n).toString(16).padStart(40, "0")}`;

let db: TestDatabase;
let app: ReturnType<typeof createApiApp>;
const get = (path: string) => app.request(path);
const post = (path: string, body: unknown) =>
  app.request(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });

function fresh(): void {
  app = createApiApp({
    sql: db.sql,
    config: { CORS_ORIGINS: [], API_RATE_LIMIT_PER_MINUTE: 0, API_CLIENT_IP_HEADER: "", NETWORK: "mainnet" },
    deployment: testDeployment(),
    logger: pino({ level: "silent" }),
    cache: new TtlCache(),
  } as unknown as ApiDependencies);
}

async function setNav(nav: number, optionLiability = 0): Promise<void> {
  await db.sql`DELETE FROM pool_nav`;
  await db.sql`INSERT INTO pool_nav (ts, block, usdg, hedge_equity, option_liability, reserve, nav, nav_per_share)
    VALUES (${at(-30_000)}, 900, ${nav}, 0, ${optionLiability}, 0, ${nav}, 1)`;
}

let log = 0;
async function deposit(account: string, usdg: number, offsetMs: number): Promise<void> {
  log += 1;
  await db.sql`INSERT INTO pool_events (tx_hash, log_index, block, ts, kind, account, sender, receiver, assets, shares)
    VALUES (${`0xdep${log}`}, 1, ${100 + log}, ${at(offsetMs)}, 'deposit', ${account}, ${account}, ${account}, ${usdg}, ${usdg})`;
  await db.sql`INSERT INTO transfers (tx_hash, log_index, block, ts, series_id, token, from_addr, to_addr, amount)
    VALUES (${`0xdep${log}`}, 0, ${100 + log}, ${at(offsetMs)}, NULL, ${POOL}, ${ZERO}, ${account}, ${usdg})`;
}
async function requestWithdraw(account: string, shares: number, offsetMs: number): Promise<void> {
  log += 1;
  await db.sql`INSERT INTO transfers (tx_hash, log_index, block, ts, series_id, token, from_addr, to_addr, amount)
    VALUES (${`0xwd${log}`}, 0, ${100 + log}, ${at(offsetMs)}, NULL, ${POOL}, ${account}, ${POOL}, ${shares})`;
}

suite("zero-seed launch: empty and small pool, writer rewards", () => {
  beforeAll(async () => {
    setSystemTime(new Date(NOW));
    db = (await createTestDatabase("zeroseed"))!;
    await applyMigrations(db);
    for (const [n, isCall, speed, strike] of [[1, true, "WEEKLY", 220], [2, false, "WEEKLY", 200], [3, true, "DAILY", 220]] as const) {
      await db.sql`INSERT INTO series (id, stock_token, name, feed, is_call, speed, tau_s, strike, token, norm, last_accrual, buyable, archived, listed_at, listed_block, listed_tx, listed_log)
        VALUES (${id(n)}, ${NVDA}, 'NVDA', ${ADDR.nvdaFeed}, ${isCall}, ${speed}, ${speed === "DAILY" ? 86400 : 604800},
          ${strike}, ${token(n)}, 1, ${at(-60_000)}, true, false, ${at(-DAY)}, 100, ${`0xlist${n}`}, ${n})`;
    }
    await db.sql`INSERT INTO ticks (stock_token, name, ts, block, spot, session, fresh, buys_paused, price_updated_at)
      VALUES (${NVDA}, 'NVDA', ${at(0)}, 900, 220, 'REGULAR', true, false, ${at(-60_000)})`;
    for (const [index, speed] of (["DAILY", "WEEKLY"] as const).entries()) {
      await db.sql`INSERT INTO vol_posts (tx_hash, log_index, block, ts, stock_token, name, speed, sigma_bps, skew_k, event_bump_bps, valid_until, nonce)
        VALUES (${`0xvol${index}`}, 0, 150, ${at(-600_000)}, ${NVDA}, 'NVDA', ${speed}, 5000, 0, 0, ${at(3_600_000)}, ${index + 1})`;
    }
    // Holders bought earlier (when the pool was not empty); they must always be able to sell.
    await db.sql`INSERT INTO transfers (tx_hash, log_index, block, ts, series_id, token, from_addr, to_addr, amount)
      VALUES ('0xbuy', 0, 120, ${at(-DAY)}, ${id(1)}, ${token(1)}, ${ZERO}, ${ADDR.alice}, 2)`;
    await db.sql`INSERT INTO balances (token, account, balance, updated_block) VALUES (${token(1)}, ${ADDR.alice}, 2, 120)`;
    fresh();
  });
  afterAll(async () => {
    setSystemTime();
    await db.close();
  });

  test("before the first pool snapshot /v1/pool still answers: stage empty, no room, no deposits", async () => {
    const body = await (await get("/v1/pool")).json() as any;
    expect(body.nav).toBe("0");
    expect(body.capacity.stage).toBe("empty");
    expect(body.capacity.minTradeUsdg).toBe("1");
    for (const row of body.capacity.names) expect(row.canBuyMinimum).toBe(false);
    expect(body.writers).toEqual({ depositedUsdg: "0", claimedUsdg: "0", wallets: 0 });
  });

  test("NAV 0: quotes, buy and shield intents give POOL_FILLING with a plain message, never a raw revert", async () => {
    await setNav(0);
    fresh();
    const pool = await (await get("/v1/pool")).json() as any;
    expect(pool.capacity.stage).toBe("empty");
    expect(pool.capacity.names.find((row: any) => row.name === "NVDA")).toMatchObject({ maxBuyUsdg: "0.000000", canBuyMinimum: false, session: "REGULAR" });

    const quote = await (await post("/v1/quote", { series: id(1), units: "1", side: "buy" })).json() as any;
    expect(quote.blockReason).toBe("POOL_FILLING");
    expect(quote.capacity).toEqual({ maxBuyUsdg: "0.000000", poolFilling: true });

    const buy = await post("/v1/intent/buy", { series: id(1), units: "1", account: ADDR.bob });
    expect(buy.status).toBe(409);
    const body = await buy.json() as any;
    expect(body.reason).toBe("POOL_FILLING");
    expect(body.message).toBe("The pool is filling. Trading opens as writers deposit into the Writer Pool. Sells stay open.");
    expect(body.capacity.poolFilling).toBe(true);
    expect(JSON.stringify(body)).not.toMatch(/revert|CapExceeded|0x[0-9a-f]{8}/i);

    const shield = await post("/v1/intent/shield", { name: "NVDA", tokenUnits: "1", account: ADDR.bob });
    expect(shield.status).toBe(409);
    expect((await shield.json() as any).reason).toBe("POOL_FILLING");

    const chain = await (await get("/v1/chains/NVDA")).json() as any;
    const weekly = chain.speeds.find((s: any) => s.speed === "WEEKLY");
    expect(weekly.strikes.find((row: any) => row.strike === "220").call.blockReason).toBe("POOL_FILLING");
  });

  test("sells are never blocked by an empty pool", async () => {
    await setNav(0, 5);
    fresh();
    const sellQuote = await (await post("/v1/quote", { series: id(1), units: "1", side: "sell", account: ADDR.alice })).json() as any;
    expect(sellQuote.blockReason).toBeNull();
    expect(sellQuote.capacity).toBeNull();
    const sell = await post("/v1/intent/sell", { series: id(1), units: "1", account: ADDR.alice });
    expect(sell.status).toBe(200);
    expect((await sell.json() as any).kind).toBe("sell");
  });

  test("a tiny pool: stage filling, room per stock from the cap math, oversize buys say how much fits", async () => {
    await setNav(10_000);
    fresh();
    const pool = await (await get("/v1/pool")).json() as any;
    expect(pool.capacity.stage).toBe("filling");
    // $10,000 NAV: 2% series cap = $200 per buy on a fresh series (name cap 8% = $800, total 35% = $3,500)
    expect(pool.capacity.names.find((row: any) => row.name === "NVDA")).toMatchObject({ maxBuyUsdg: "200.000000", canBuyMinimum: true });

    const small = await (await post("/v1/quote", { series: id(1), units: "1", side: "buy" })).json() as any;
    expect(small.blockReason).toBeNull();
    // series 1 already has alice's 2 options outstanding (about $10.77), so its own room is a little under $200
    expect(small.capacity.poolFilling).toBe(false);
    const room = Number(small.capacity.maxBuyUsdg);
    expect(room).toBeGreaterThan(180);
    expect(room).toBeLessThan(200);

    const big = await post("/v1/intent/buy", { series: id(1), units: "1000", account: ADDR.bob });
    expect(big.status).toBe(409);
    const body = await big.json() as any;
    expect(body.reason).toBe("CAP_REACHED");
    expect(body.message).toContain(`Right now about ${room.toFixed(2)} USDG of option value fits on this option.`);

    await setNav(30_000);
    fresh();
    expect((await (await get("/v1/pool")).json() as any).capacity.stage).toBe("open");
  });

  test("writer rewards before $LMNS: status awaiting_token, a 7-day preview from the fake history, the wallet's own row", async () => {
    await setNav(30_000);
    // alice: 2,000 for 10 days, asks to withdraw half 1 day ago -> 6 days x 2,000 + 1 day x 1,000 = 13,000 USDG-days
    await deposit(ADDR.alice.toLowerCase(), 2_000, -10 * DAY);
    await requestWithdraw(ADDR.alice.toLowerCase(), 1_000, -DAY);
    // bob: 500 for the whole week -> under the 1,000 minimum
    await deposit(ADDR.bob.toLowerCase(), 500, -9 * DAY);
    // carol: 5,000 for 3.5 days -> 17,500 USDG-days, average 2,500
    await deposit(ADDR.carol.toLowerCase(), 5_000, -3.5 * DAY);
    // the owner's wallet deposits too: never eligible
    await deposit(OWNER, 100_000, -8 * DAY);
    // dave received shares by transfer only: they do not count
    log += 1;
    await db.sql`INSERT INTO transfers (tx_hash, log_index, block, ts, series_id, token, from_addr, to_addr, amount)
      VALUES (${`0xgift${log}`}, 0, ${100 + log}, ${at(-2 * DAY)}, NULL, ${POOL}, ${ADDR.carol.toLowerCase()}, ${ADDR.dave.toLowerCase()}, 0)`;
    fresh();

    const body = await (await get(`/v1/writers/rewards?address=${ADDR.alice}`)).json() as any;
    expect(body.program.status).toBe("awaiting_token");
    expect(body.program.message).toBe("Rewards start when $LMNS launches. Until then the numbers here are a preview of the last 7 days.");
    expect(body.program.weeklyPoolTokens).toBe("1000000");
    expect(body.program.weeklyPoolPctOfSupply).toBe(0.1);
    expect(body.program.weeks).toBe(8);
    expect(body.program.perWalletCapPct).toBe(10);
    expect(body.program.minTimeWeightedUsdg).toBe(1000);
    expect(body.program.tokenAddress).toBeNull();
    expect(body.week.preview).toBe(true);
    expect(body.week.basis).toBe("illustrative");
    expect(body.program.rules.join(" ")).toContain("no identity check");
    expect(body.week.number).toBeNull();
    expect(body.week.eligibleWallets).toBe(2); // alice and carol
    expect(body.week.totalPointsUsdgDays).toBe("30500.00");
    // both are over the 10% cap (100,000 LMNS); the rest is not paid out
    expect(body.week.allocatedTokens).toBe("200000");
    expect(body.week.unallocatedTokens).toBe("800000");
    expect(body.you).toMatchObject({
      eligible: true, excluded: false, depositHeldUsdg: "1000.000000", pointsUsdgDays: "13000.00", tokens: "100000", capped: true,
    });
    expect(Number(body.you.timeWeightedUsdg)).toBeCloseTo(13_000 / 7, 4);

    const owner = await (await get(`/v1/writers/rewards?address=${OWNER}`)).json() as any;
    expect(owner.you).toMatchObject({ eligible: false, excluded: true, tokens: "0" });
    expect(owner.you.reason).toBe("excluded: project wallet (owner)");
    const bob = await (await get(`/v1/writers/rewards?address=${ADDR.bob}`)).json() as any;
    expect(bob.you).toMatchObject({ eligible: false, reason: "time-weighted deposit under 1000 USDG" });
    const dave = await (await get(`/v1/writers/rewards?address=${ADDR.dave}`)).json() as any;
    expect(dave.you).toMatchObject({ eligible: false, tokens: "0", reason: "no deposit held during the week" });

    expect((await get("/v1/writers/rewards?week=1")).status).toBe(404);
    expect((await get("/v1/writers/rewards?address=nope")).status).toBe(400);
    const pool = await (await get("/v1/pool")).json() as any;
    expect(pool.writers).toEqual({ depositedUsdg: "107500", claimedUsdg: "0", wallets: 4 });
  });

  test("a live week from the same history: bounds from startAt, only flows inside the week count, sums match the pool", async () => {
    const config: WriterRewardsConfig = {
      ...writerRewards, tokenAddress: "0x00000000000000000000000000000000000001aa" as const, startAt: new Date(NOW - 7 * DAY).toISOString(), excludedWalletsReviewed: true,
    };
    const table = await buildWeek({ sql: db.sql, pool: POOL, contracts: testDeployment().contracts as Record<string, string>, week: 1, nowSec: NOW / 1000, config });
    expect(table).not.toBeNull();
    expect(table!.allocatedUnits + table!.unallocatedUnits).toBe(weeklyPoolUnits(config));
    expect(table!.rows.find((row) => row.address === OWNER)!.reason).toBe("excluded: project wallet (owner)");
    expect(await buildWeek({ sql: db.sql, pool: POOL, contracts: {}, week: 9, nowSec: NOW / 1000, config })).toBeNull();
  });

  test("L3: figures are labelled illustrative (preview), projected (running week) or final", () => {
    expect(weekBasis(null, false)).toBe("illustrative");
    expect(weekBasis(2, false)).toBe("projected");
    expect(weekBasis(2, true)).toBe("final");
  });

  test("no copy-rule words in the new responses", async () => {
    fresh();
    const texts = await Promise.all([
      get("/v1/pool"), get(`/v1/writers/rewards?address=${ADDR.alice}`),
      post("/v1/intent/buy", { series: id(1), units: "1000", account: ADDR.bob }),
    ].map(async (promise) => (await promise).text()));
    const banned = /\b(apy|apr|yield|yields|income|free|guaranteed|risk-free|earn|earns|earning|returns?)\b|can't lose|no fees|partnership|endorse/i;
    for (const text of texts) expect(text).not.toMatch(banned);
  });
});
