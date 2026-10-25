import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import { HASH_WINDOW, ReorgTooDeepError, repairReorg, runIndexerTick, MAX_REORG_DEPTH } from "./ingest";
import {
  ADDR, BASE_TIME, DEPLOY_BLOCK, FakeChain, FakeReader, SERIES_CALL, SERIES_PUT, b32, dumpTables, ev, makeIndexer, syncToHead, testSettings, type LogSpec,
} from "./test-support";

const enabled = Boolean(testDatabaseUrl());
const suite = enabled ? describe : describe.skip;

/** A migrated database of its own for one test, dropped afterwards. */
async function withDb(label: string, run: (db: TestDatabase) => Promise<void>): Promise<void> {
  const db = (await createTestDatabase(label))!;
  try {
    await applyMigrations(db);
    await run(db);
  } finally {
    await db.close();
  }
}

const asTime = (value: unknown): number => new Date(String(value)).getTime();

const WAD = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as const;
const strike = 110n * WAD;

/** A busy history: listing, trades, transfers, accruals, a pause, a queue ticket. One thing per block. */
function buildHistory(chain: FakeChain): void {
  chain.mine([ev.seriesListed(SERIES_CALL, ADDR.nvda, true, 1, strike, ADDR.tokenCall)]); // 100
  chain.mine([ev.buyableSet(SERIES_CALL, true)]); // 101
  chain.mine([
    ev.transfer(ADDR.tokenCall, ZERO, ADDR.alice, 3n * WAD),
    ev.bought(SERIES_CALL, ADDR.alice, ADDR.alice, 3n * WAD, 3n * WAD, 8_125_000n, 2_708_333_333_333_333_333n),
  ]); // 102
  chain.mine([ev.accrued(SERIES_CALL, 999_000_000_000_000_000n, 2_700_000_000_000_000_000n, WAD)]); // 103
  chain.mine([ev.transfer(ADDR.tokenCall, ADDR.alice, ADDR.bob, WAD)]); // 104
  chain.mine([ev.hedgeEquity(100_000_000n, BigInt(BASE_TIME), b32(1))]); // 105
  chain.mine([ev.accrued(SERIES_CALL, 998_000_000_000_000_000n, 2_650_000_000_000_000_000n, WAD)]); // 106
  chain.mine([
    ev.transfer(ADDR.tokenCall, ADDR.bob, ZERO, WAD),
    ev.sold(SERIES_CALL, ADDR.bob, ADDR.bob, WAD, WAD, 2_600_000n, 2_600_000_000_000_000_000n),
  ]); // 107
  chain.mine([ev.buysPaused(true, b32(0), true)]); // 108
  chain.mine([ev.sellQueued(1n, SERIES_CALL, ADDR.alice, ADDR.alice, WAD, 1_790_000_000n)]); // 109
  chain.mine([ev.queuedFilled(1n, ADDR.carol, 2_000_000n)]); // 110
}

/** The branch that replaces blocks 106.. after a reorg at 105: different events, one listing that only exists there. */
const replacementBranch = (): LogSpec[][] => [
  [ev.accrued(SERIES_CALL, 997_000_000_000_000_000n, 2_640_000_000_000_000_000n, WAD)], // 106'
  [
    ev.transfer(ADDR.tokenCall, ADDR.alice, ADDR.carol, 2n * WAD),
    ev.bought(SERIES_CALL, ADDR.carol, ADDR.carol, 2n * WAD, 2n * WAD, 5_000_000n, 2_500_000_000_000_000_000n),
  ], // 107'
  [ev.seriesListed(SERIES_PUT, ADDR.nvda, false, 0, 90n * WAD, ADDR.tokenPut)], // 108'
  [ev.sellQueued(2n, SERIES_CALL, ADDR.bob, ADDR.bob, WAD, 1_790_000_100n)], // 109'
  [],
  [ev.buyableSet(SERIES_CALL, false)], // 111'
];

suite("idempotentReplay", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = (await createTestDatabase("replay"))!;
    await applyMigrations(db);
  });
  afterAll(async () => db.close());

  test("ingesting the same blocks twice leaves identical tables", async () => {
    const chain = new FakeChain();
    buildHistory(chain);
    const { state } = await makeIndexer(db.sql, chain);
    await syncToHead(state);
    const first = await dumpTables(db.sql);
    expect((first.trades as unknown[]).length).toBe(2);

    // Replay everything from the deployment block.
    await db.sql`DELETE FROM block_hashes`;
    await db.sql`UPDATE cursors SET block = ${DEPLOY_BLOCK - 1} WHERE name = 'main'`;
    state.cursor = BigInt(DEPLOY_BLOCK - 1);
    state.pendingSnapshot = true;
    await syncToHead(state);
    expect(await dumpTables(db.sql)).toEqual(first);

    // Replay an overlapping tail only (as after a crash between the writes and the cursor update).
    await db.sql`DELETE FROM block_hashes`;
    await db.sql`UPDATE cursors SET block = 104 WHERE name = 'main'`;
    state.cursor = 104n;
    await syncToHead(state);
    expect(await dumpTables(db.sql)).toEqual(first);
  });

  test("a tick with nothing new changes nothing", async () => {
    const before = await dumpTables(db.sql);
    const chain = new FakeChain();
    buildHistory(chain);
    const { state } = await makeIndexer(db.sql, chain);
    const result = await runIndexerTick(state);
    expect(result.events).toBe(0);
    expect(await dumpTables(db.sql)).toEqual(before);
  });
});

suite("reorgSafe", () => {
  let dbA: TestDatabase;
  let dbB: TestDatabase;
  beforeAll(async () => {
    dbA = (await createTestDatabase("reorg_a"))!;
    dbB = (await createTestDatabase("reorg_b"))!;
    await applyMigrations(dbA);
    await applyMigrations(dbB);
  });
  afterAll(async () => {
    await dbA.close();
    await dbB.close();
  });

  test("a reorg at depth 5 removes the orphaned rows and ends where a clean ingest of the new chain does", async () => {
    // Indexer A follows the old chain to its head, then the chain reorganises under it.
    const chainA = new FakeChain();
    buildHistory(chainA);
    const a = await makeIndexer(dbA.sql, chainA);
    await syncToHead(a.state);
    const orphanedTrades = await dbA.sql`SELECT count(*)::int AS n FROM trades WHERE block > 105`;
    expect(Number(orphanedTrades[0]?.n)).toBe(1); // the sell in block 107

    chainA.reorg(105n, replacementBranch());
    const result = await runIndexerTick(a.state);
    expect(result.reorgDepth).toBe(5n);
    await syncToHead(a.state);

    // Indexer B never saw the old chain.
    const chainB = new FakeChain();
    buildHistory(chainB);
    chainB.reorg(105n, replacementBranch());
    const b = await makeIndexer(dbB.sql, chainB);
    await syncToHead(b.state);

    const tablesA = await dumpTables(dbA.sql);
    expect(tablesA).toEqual(await dumpTables(dbB.sql));

    // And the end state is the new chain's.
    expect(tablesA.trades).toHaveLength(2);
    expect((tablesA.trades as { account: string }[]).map((row) => row.account)).toEqual([ADDR.alice, ADDR.carol]);
    expect((tablesA.series as { id: string }[]).map((row) => row.id).sort()).toEqual([SERIES_CALL, SERIES_PUT].sort());
    expect((tablesA.queued_sells as { ticket: string; status: string }[]).map((row) => [row.ticket, row.status])).toEqual([["2", "open"]]);
    const cursor = await dbA.sql`SELECT block FROM cursors WHERE name = 'main'`;
    expect(String(cursor[0]?.block)).toBe(String(await chainA.getHead()));
    const balances = (tablesA.balances as { account: string; balance: string }[]).map((row) => [row.account, row.balance]);
    expect(balances).toContainEqual([ADDR.carol, "2.000000000000000000"]);
  });

  test("a series listed only on the orphaned branch disappears with it", async () => {
    const db = (await createTestDatabase("reorg_series"))!;
    try {
      await applyMigrations(db);
      const chain = new FakeChain();
      buildHistory(chain);
      chain.mine([ev.seriesListed(SERIES_PUT, ADDR.nvda, false, 0, 90n * WAD, ADDR.tokenPut), ev.buyableSet(SERIES_PUT, true)]); // 111
      const { state } = await makeIndexer(db.sql, chain);
      await syncToHead(state);
      expect(Number((await db.sql`SELECT count(*)::int AS n FROM series`)[0]?.n)).toBe(2);
      chain.reorg(110n, [[], []]);
      await syncToHead(state);
      expect((await db.sql`SELECT id FROM series`).map((row) => row.id)).toEqual([SERIES_CALL]);
      expect(Number((await db.sql`SELECT count(*)::int AS n FROM series_flag_log WHERE series_id = ${SERIES_PUT}`)[0]?.n)).toBe(0);
    } finally {
      await db.close();
    }
  });

  test("a reorg deeper than the limit is refused and changes nothing", async () => {
    const db = (await createTestDatabase("reorg_deep"))!;
    try {
      await applyMigrations(db);
      const chain = new FakeChain();
      buildHistory(chain);
      chain.mineEmpty(30); // head 140
      const { state } = await makeIndexer(db.sql, chain);
      await syncToHead(state);
      const before = await dumpTables(db.sql);
      expect(MAX_REORG_DEPTH).toBe(20n);
      chain.reorg(110n, Array.from({ length: 31 }, () => [] as LogSpec[])); // 30 blocks replaced
      await expect(repairReorg(state)).rejects.toBeInstanceOf(ReorgTooDeepError);
      expect(await dumpTables(db.sql)).toEqual(before);
      expect(state.cursor).toBe(140n);
      expect(HASH_WINDOW).toBeGreaterThan(MAX_REORG_DEPTH);
    } finally {
      await db.close();
    }
  });

  test("a reorg while confirmations are kept never reaches the database", async () => {
    const db = (await createTestDatabase("reorg_conf"))!;
    try {
      await applyMigrations(db);
      const chain = new FakeChain();
      buildHistory(chain);
      const { state } = await makeIndexer(db.sql, chain, { settings: { confirmations: 3, pollActiveMs: 0, pollBaseMs: 1, pollIdleMs: 1 } });
      await syncToHead(state);
      expect(state.cursor).toBe(107n); // head 110 - 3
      chain.reorg(108n, replacementBranch().slice(2)); // only unconfirmed blocks change
      const result = await runIndexerTick(state);
      expect(result.reorgDepth).toBeUndefined();
      await syncToHead(state);
      expect(Number((await db.sql`SELECT count(*)::int AS n FROM trades`)[0]?.n)).toBe(2);
    } finally {
      await db.close();
    }
  });
});

suite("poolNavSnapshots", () => {
  test("a trade triggers a snapshot of pool_nav, ticks and limits_state with exact decimals", () => withDb("snap_trade", async (db) => {
    const chain = new FakeChain();
    chain.mine([ev.seriesListed(SERIES_CALL, ADDR.nvda, true, 1, strike, ADDR.tokenCall)]);
    const reader = new FakeReader();
    // netGreeks is the holders' long side (decision 21): the pool is short 2 units of delta and 0.1 of gamma.
    reader.stocks[ADDR.nvda] = { deltaWad: 2n * WAD, gammaWad: WAD / 10n, vegaWad: 5n * WAD, spotWad: 120n * WAD };
    const { state } = await makeIndexer(db.sql, chain, { reader });
    await syncToHead(state);
    const base = reader.poolCalls;

    const block = chain.mine([ev.bought(SERIES_CALL, ADDR.alice, ADDR.alice, WAD, WAD, 1_000_000n, WAD)]);
    await syncToHead(state);
    expect(reader.poolCalls).toBe(base + 1);

    const nav = await db.sql`SELECT block, usdg, hedge_equity, option_liability, reserve, nav, nav_per_share FROM pool_nav ORDER BY ts DESC LIMIT 1`;
    expect(nav[0]).toEqual({
      block: String(block),
      usdg: "1500.000000000000000000",
      hedge_equity: "250.000000000000000000",
      option_liability: "400.000000000000000000",
      reserve: "75.000000000000000000",
      nav: "1350.000000000000000000",
      nav_per_share: "1.050000000000000000",
    });

    const limits = await db.sql`SELECT name, net_delta, net_gamma, net_vega, stress_loss_bps FROM limits_state WHERE block = ${String(block)} ORDER BY name`;
    expect(limits.map((row) => row.name)).toEqual(["NVDA", "TSLA"]);
    const nvda = limits.find((row) => row.name === "NVDA")!;
    expect(nvda.net_delta).toBe("2.000000000000000000");
    expect(nvda.net_gamma).toBe("0.100000000000000000");
    expect(nvda.net_vega).toBe("5.000000000000000000");
    // pool = -book (delta -2, gamma -0.1). gap 25% of 120 = 30: down: -2*-30 - 45 = +15; up: -2*30 - 45 = -105 -> loss 105 of NAV 1350 = 777.7777 bps
    expect(nvda.stress_loss_bps).toBe("777.7777");

    const ticks = await db.sql`SELECT name, spot, session, fresh, sigma_daily_bps, sigma_weekly_bps, vol_stale FROM ticks WHERE block = ${String(block)} ORDER BY name`;
    expect(ticks[0]).toEqual({ name: "NVDA", spot: "120.000000000000000000", session: "REGULAR", fresh: true, sigma_daily_bps: 5000, sigma_weekly_bps: 4800, vol_stale: false });
  }));

  test("decision 30: a buy or a received transfer makes the snapshot read and store the account's hold; the trade TWAP is kept", () => withDb("snap_hold", async (db) => {
    const chain = new FakeChain();
    chain.mine([ev.seriesListed(SERIES_CALL, ADDR.nvda, true, 1, strike, ADDR.tokenCall)]);
    const reader = new FakeReader();
    reader.stocks[ADDR.nvda] = { tradeTwapWad: 121n * WAD, haltedSince: 0n };
    const { state } = await makeIndexer(db.sql, chain, { reader });
    await syncToHead(state);
    const far = BigInt(Math.floor(Date.now() / 1000)) + 10n ** 9n; // open for the whole test, whatever the block clock
    reader.holds[`${SERIES_CALL}:${ADDR.alice}`] = { until: far, sWad: 120n * WAD };
    reader.holds[`${SERIES_CALL}:${ADDR.bob}`] = { until: far, sWad: 119n * WAD };
    chain.mine([
      ev.transfer(ADDR.tokenCall, ZERO, ADDR.alice, WAD),
      ev.bought(SERIES_CALL, ADDR.alice, ADDR.alice, WAD, WAD, 1_000_000n, WAD),
    ]);
    chain.mine([ev.transfer(ADDR.tokenCall, ADDR.alice, ADDR.bob, WAD / 2n)]);
    await syncToHead(state);
    const holds = await db.sql`SELECT series_id, account, s::text AS s FROM holds ORDER BY account`;
    expect(holds.map((row) => [row.account, row.s])).toEqual([[ADDR.bob, "119.000000000000000000"], [ADDR.alice, "120.000000000000000000"]]);
    const tick = await db.sql`SELECT trade_twap::text AS twap, settle_price, halted_since FROM ticks WHERE name = 'NVDA' ORDER BY ts DESC LIMIT 1`;
    expect(tick[0]).toEqual({ twap: "121.000000000000000000", settle_price: null, halted_since: null });
    // an expired hold clears the stored row at the next snapshot
    reader.holds[`${SERIES_CALL}:${ADDR.bob}`] = { until: 1n, sWad: 119n * WAD };
    chain.mine([ev.bought(SERIES_CALL, ADDR.carol, ADDR.carol, WAD, WAD, 1_000_000n, WAD)]);
    await syncToHead(state);
    expect((await db.sql`SELECT account FROM holds ORDER BY account`).map((row) => row.account)).toEqual([ADDR.alice]);
  }));

  test("with no trades the indexer still snapshots at least every 10 minutes", () => withDb("snap_heartbeat", async (db) => {
    const chain = new FakeChain();
    let clock = 1_000_000;
    const reader = new FakeReader();
    const { state } = await makeIndexer(db.sql, chain, { reader, now: () => clock });
    await syncToHead(state);
    const calls = reader.poolCalls;

    chain.mine();
    clock += 60_000;
    await runIndexerTick(state);
    expect(reader.poolCalls).toBe(calls); // an empty block inside the heartbeat window: no snapshot

    chain.mine();
    clock += 10 * 60_000;
    await runIndexerTick(state);
    expect(reader.poolCalls).toBe(calls + 1);
    expect(Number((await db.sql`SELECT count(*)::int AS n FROM pool_nav`)[0]?.n)).toBe(2);
  }));

  test("27d: a shorter snapshotHeartbeatMs (fork profile) snapshots sooner than the 10-minute production default", () => withDb("snap_heartbeat_short", async (db) => {
    const chain = new FakeChain();
    let clock = 1_000_000;
    const reader = new FakeReader();
    const { state } = await makeIndexer(db.sql, chain, { reader, now: () => clock, settings: { ...testSettings, snapshotHeartbeatMs: 60_000 } });
    await syncToHead(state);
    const calls = reader.poolCalls;
    chain.mine();
    clock += 30_000;
    await runIndexerTick(state);
    expect(reader.poolCalls).toBe(calls);
    chain.mine();
    clock += 31_000;
    await runIndexerTick(state);
    expect(reader.poolCalls).toBe(calls + 1);
  }));

  test("a failing snapshot keeps the work pending and reports the error without losing events", () => withDb("snap_fail", async (db) => {
    const chain = new FakeChain();
    const reader = new FakeReader();
    const { state } = await makeIndexer(db.sql, chain, { reader });
    await syncToHead(state);
    reader.fail = true;
    chain.mine([ev.bought(SERIES_CALL, ADDR.alice, ADDR.alice, WAD, WAD, 1_000_000n, WAD)]);
    await runIndexerTick(state);
    expect(state.pendingSnapshot).toBe(true);
    const status = await db.sql`SELECT last_error FROM keeper_status WHERE job = 'indexer'`;
    expect(String(status[0]?.last_error)).toContain("rpc down");
    expect(Number((await db.sql`SELECT count(*)::int AS n FROM trades WHERE block = ${String(await chain.getHead())}`)[0]?.n)).toBe(1);
    reader.fail = false;
    await syncToHead(state);
    expect(state.pendingSnapshot).toBe(false);
  }));

  test("series state is reconciled with the registry at each snapshot", () => withDb("snap_series", async (db) => {
    const chain = new FakeChain();
    chain.mine([ev.seriesListed(SERIES_PUT, ADDR.tsla, false, 0, 90n * WAD, ADDR.tokenPut)]);
    const reader = new FakeReader();
    reader.series[SERIES_PUT] = { buyable: true, archived: false, norm: 993n * 10n ** 15n, lastAccrual: BigInt(BASE_TIME + 100) };
    const { state } = await makeIndexer(db.sql, chain, { reader });
    await syncToHead(state);
    const row = await db.sql`SELECT buyable, norm, last_accrual FROM series WHERE id = ${SERIES_PUT}`;
    expect(row[0]?.buyable).toBe(true);
    expect(row[0]?.norm).toBe("0.993000000000000000");
    expect(asTime(row[0]?.last_accrual)).toBe((BASE_TIME + 100) * 1_000);
  }));
});

suite("healthEndpointData", () => {
  test("the status row carries last ok, head, indexed block and lag for the keeper", () => withDb("status", async (db) => {
    const chain = new FakeChain();
    buildHistory(chain);
    const clock = Date.UTC(2026, 9, 16, 12, 0, 0);
    const { state } = await makeIndexer(db.sql, chain, { settings: { confirmations: 4, pollActiveMs: 0, pollBaseMs: 1, pollIdleMs: 1 }, now: () => clock });
    await syncToHead(state);
    const row = (await db.sql`SELECT last_ok, last_error, meta FROM keeper_status WHERE job = 'indexer'`)[0]!;
    expect(row.last_error).toBeNull();
    expect(Number.isFinite(asTime(row.last_ok))).toBe(true);
    const meta = row.meta as Record<string, unknown>;
    expect(meta.lastHeadBlock).toBe("110");
    expect(meta.lastIndexedBlock).toBe("106");
    expect(meta.lagBlocks).toBe("4");
    expect(meta.pendingSnapshot).toBe(false);
    expect(typeof meta.lastSnapshotAt).toBe("string");
    expect(Number(meta.chainTimestamp)).toBeGreaterThan(0);
    expect(meta.chainTimeObservedAt).toBe(new Date(clock).toISOString());
    expect((meta.deployment as { stocks: string[] }).stocks).toEqual(["NVDA", "TSLA"]);
  }));

  test("a failing tick records the error and keeps the last good time", () => withDb("status_err", async (db) => {
    const chain = new FakeChain();
    const { state } = await makeIndexer(db.sql, chain);
    await syncToHead(state);
    const ok = (await db.sql`SELECT last_ok FROM keeper_status WHERE job = 'indexer'`)[0]!.last_ok;
    const { recordIndexerFailure } = await import("./ingest");
    await recordIndexerFailure(state, new Error("boom"));
    const row = (await db.sql`SELECT last_ok, last_error FROM keeper_status WHERE job = 'indexer'`)[0]!;
    expect(row.last_error).toBe("boom");
    expect(asTime(row.last_ok)).toBe(asTime(ok));
  }));
});

suite("rpc limits", () => {
  test("a log range the node rejects is halved until it fits, and nothing is skipped", () => withDb("range", async (db) => {
    class LimitedChain extends FakeChain {
      limit = 4n;
      rejected = 0;
      override async getLogs(range: Parameters<FakeChain["getLogs"]>[0]) {
        if (range.toBlock - range.fromBlock + 1n > this.limit) {
          this.rejected += 1;
          throw new Error("query exceeds max block range");
        }
        return super.getLogs(range);
      }
    }
    const chain = new LimitedChain();
    buildHistory(chain);
    const { state } = await makeIndexer(db.sql, chain);
    state.range = 16n;
    await syncToHead(state);
    expect(chain.rejected).toBeGreaterThan(0);
    expect(state.range).toBeLessThanOrEqual(4n);
    expect(Number((await db.sql`SELECT count(*)::int AS n FROM trades`)[0]?.n)).toBe(2);
    expect(Number((await db.sql`SELECT count(*)::int AS n FROM norm_history`)[0]?.n)).toBe(2);
  }));

  test("logs from contracts the indexer does not watch are ignored", () => withDb("unwatched", async (db) => {
    const chain = new FakeChain();
    chain.mine([ev.transfer(ADDR.carol, ADDR.alice, ADDR.bob, WAD)]); // an unrelated token
    const { state } = await makeIndexer(db.sql, chain);
    await syncToHead(state);
    expect(Number((await db.sql`SELECT count(*)::int AS n FROM transfers`)[0]?.n)).toBe(0);
  }));
});
