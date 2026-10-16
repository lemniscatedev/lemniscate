import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { ADDR, FakeChain, FakeReader, SERIES_CALL, SERIES_PUT, b32, ev, makeIndexer, syncToHead, a } from "../../indexer/test-support";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../../testing/db";
import { accountPositions, recentTrades } from "./positions";
import { latestLimits, latestPoolNav, latestVolPosts, openQueuedSells, poolNavHistory, queuedWithdrawals } from "./pool";
import { getSeries, listSeries, listedNames, normHistory } from "./series";

const suite = testDatabaseUrl() ? describe : describe.skip;
const WAD = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const SERIES_TSLA = b32(0x7515);
const TOKEN_TSLA = a(0x4003);

suite("db queries over indexed data", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = (await createTestDatabase("queries"))!;
    await applyMigrations(db);
    const chain = new FakeChain();
    chain.mine([
      ev.seriesListed(SERIES_CALL, ADDR.nvda, true, 1, 110n * WAD, ADDR.tokenCall),
      ev.seriesListed(SERIES_PUT, ADDR.nvda, false, 0, 90n * WAD, ADDR.tokenPut),
      ev.seriesListed(SERIES_TSLA, ADDR.tsla, true, 0, 300n * WAD, TOKEN_TSLA),
    ]);
    chain.mine([ev.buyableSet(SERIES_CALL, true), ev.buyableSet(SERIES_PUT, true), ev.archived(SERIES_TSLA)]);
    chain.mine([
      ev.transfer(ADDR.tokenCall, ZERO, ADDR.alice, 4n * WAD),
      ev.bought(SERIES_CALL, ADDR.alice, ADDR.alice, 4n * WAD, 4n * WAD, 10_000_000n, 2_500_000_000_000_000_000n),
    ]);
    chain.mine([ev.accrued(SERIES_CALL, 990_000_000_000_000_000n, 2_400_000_000_000_000_000n, WAD)]);
    chain.mine([
      ev.transfer(ADDR.tokenCall, ADDR.alice, ADDR.bob, WAD),
      ev.sold(SERIES_CALL, ADDR.alice, ADDR.alice, WAD, WAD, 2_000_000n, 2_000_000_000_000_000_000n),
    ]);
    chain.mine([
      ev.withdrawalQueued(ADDR.alice, 1n, 5n * 10n ** 12n, 1_790_300_000n),
      ev.withdrawalQueued(ADDR.bob, 2n, 7n * 10n ** 12n, 1_790_200_000n),
      ev.withdrawalClaimed(ADDR.bob, 2n, 7_000_000n),
      ev.sellQueued(5n, SERIES_PUT, ADDR.carol, ADDR.carol, WAD, 1_790_000_000n),
      ev.volPosted(ADDR.nvda, 0, 5000n, 1n, 0n, 1_790_007_200n, 1n),
    ]);
    chain.mine([ev.volPosted(ADDR.nvda, 0, 5100n, 1n, 100n, 1_790_010_800n, 2n), ev.volPosted(ADDR.nvda, 1, 4700n, 1n, 0n, 1_790_010_800n, 1n)]);

    const reader = new FakeReader();
    reader.series[SERIES_CALL] = { norm: 990_000_000_000_000_000n, lastAccrual: 1_790_000_000n };
    reader.series[SERIES_PUT] = { norm: WAD, buyable: true };
    reader.stocks[ADDR.nvda] = { deltaWad: -WAD, gammaWad: WAD / 100n };
    const { state } = await makeIndexer(db.sql, chain, { reader });
    await syncToHead(state);
  });
  afterAll(async () => db.close());

  test("listSeries orders a name's grid and honours filters and archiving", async () => {
    const grid = await listSeries(db, { name: "NVDA" });
    expect(grid.map((row) => [row.speed, row.strike, row.isCall])).toEqual([
      ["DAILY", "90.000000000000000000", false],
      ["WEEKLY", "110.000000000000000000", true],
    ]);
    expect((await listSeries(db, { name: "NVDA", speed: "WEEKLY" })).map((row) => row.id)).toEqual([SERIES_CALL]);
    expect((await listSeries(db, { name: "TSLA" }))).toEqual([]);
    expect((await listSeries(db, { name: "TSLA", includeArchived: true })).map((row) => row.id)).toEqual([SERIES_TSLA]);
    expect((await listSeries(db)).length).toBe(2);
  });

  test("getSeries returns the funding state and the buyable flag", async () => {
    const row = await getSeries(db, SERIES_CALL);
    expect(row).toMatchObject({ name: "NVDA", isCall: true, tauSeconds: 604800, norm: "0.990000000000000000", buyable: true, archived: false, token: ADDR.tokenCall });
    expect(await getSeries(db, b32(1))).toBeNull();
  });

  test("listedNames reports whether anything can be bought", async () => {
    expect(await listedNames(db)).toEqual([{ name: "NVDA", buyable: true }, { name: "TSLA", buyable: false }]);
  });

  test("normHistory is newest first", async () => {
    const history = await normHistory(db, SERIES_CALL);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({ norm: "0.990000000000000000", vMark: "2.400000000000000000", payoff: "1.000000000000000000" });
  });

  test("accountPositions multiplies the balance by the norm and totals the trades", async () => {
    const alice = await accountPositions(db, ADDR.alice);
    expect(alice).toHaveLength(1);
    expect(alice[0]).toMatchObject({
      seriesId: SERIES_CALL, balance: "3.000000000000000000", norm: "0.990000000000000000", units: "2.970000000000000000",
      boughtUsdg: "10.000000000000000000", soldUsdg: "2.000000000000000000",
    });
    const bob = await accountPositions(db, ADDR.bob);
    expect(bob[0]).toMatchObject({ balance: "1.000000000000000000", boughtUsdg: "0", soldUsdg: "0" });
    expect(await accountPositions(db, ADDR.carol)).toEqual([]);
  });

  test("recentTrades filters by account and series, newest first", async () => {
    const all = await recentTrades(db, { account: ADDR.alice });
    expect(all.map((row) => row.side)).toEqual(["sell", "buy"]);
    expect((await recentTrades(db, { seriesId: SERIES_PUT })).length).toBe(0);
    expect((await recentTrades(db, { account: ADDR.alice, limit: 1 })).length).toBe(1);
  });

  test("pool snapshots, limits, tickets and vol posts", async () => {
    const nav = await latestPoolNav(db);
    expect(nav).toMatchObject({ usdg: "1500.000000000000000000", nav: "1350.000000000000000000", navPerShare: "1.050000000000000000" });
    expect((await poolNavHistory(db, new Date(0))).length).toBeGreaterThan(0);
    const limits = await latestLimits(db);
    expect(limits.map((row) => row.name)).toEqual(["NVDA", "TSLA"]);
    expect(limits[0]).toMatchObject({ netDelta: "-1.000000000000000000", netGamma: "0.010000000000000000" });
    expect((await queuedWithdrawals(db)).map((row) => [row.owner, row.ticket])).toEqual([[ADDR.alice, "1"]]);
    expect(await queuedWithdrawals(db, ADDR.bob)).toEqual([]);
    expect((await openQueuedSells(db)).map((row) => [row.ticket, row.seller])).toEqual([["5", ADDR.carol]]);
    expect(await openQueuedSells(db, ADDR.alice)).toEqual([]);
    const vols = await latestVolPosts(db);
    expect(vols.map((row) => [row.name, row.speed, row.sigmaBps, row.eventBumpBps])).toEqual([
      ["NVDA", "DAILY", 5100, 100],
      ["NVDA", "WEEKLY", 4700, 0],
    ]);
  });
});
