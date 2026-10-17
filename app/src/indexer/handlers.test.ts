import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { encodeFunctionData, type Abi, type Hex } from "viem";
import { VolOracleAbi } from "../abi";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import {
  ADDR, FakeChain, FakeReader, SERIES_CALL, SERIES_PUT, b32, ev, makeIndexer, syncToHead, type LogSpec,
} from "./test-support";

const enabled = Boolean(testDatabaseUrl());
const suite = enabled ? describe : describe.skip;

const WAD = 10n ** 18n;
const USDG = 10n ** 6n;
const strike = 110n * WAD;
const ts = (block: bigint) => new Date((1_790_000_000 + Number(block) * 2) * 1_000);

const PG_TIMESTAMP = /^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d(\.\d+)?[+-]\d\d(:?\d\d)?$/;

/** Rows as plain objects; timestamptz text from the simple protocol becomes a Date. */
async function rows(db: TestDatabase, query: string): Promise<Record<string, unknown>[]> {
  const result = [...(await db.sql.unsafe(query))] as Record<string, unknown>[];
  return result.map((row) => Object.fromEntries(Object.entries(row).map(([key, value]) => {
    if (typeof value !== "string" || !PG_TIMESTAMP.test(value)) return [key, value];
    const withColon = /[+-]\d\d$/.test(value) ? `${value}:00` : value;
    return [key, new Date(withColon.replace(" ", "T"))];
  })));
}

suite("handlersStoreEvents", () => {
  let db: TestDatabase;
  let chain: FakeChain;
  const blocks: Record<string, bigint> = {};
  const blk = (name: string): bigint => blocks[name]!;

  beforeAll(async () => {
    db = (await createTestDatabase("handlers"))!;
    await applyMigrations(db);
    chain = new FakeChain();

    blocks.listed = chain.mine([
      ev.seriesListed(SERIES_CALL, ADDR.nvda, true, 1, strike, ADDR.tokenCall),
      ev.seriesListed(SERIES_PUT, ADDR.nvda, false, 0, 90n * WAD, ADDR.tokenPut),
    ]);
    blocks.buyable = chain.mine([ev.buyableSet(SERIES_CALL, true), ev.buyableSet(SERIES_PUT, true)]);
    // alice buys 3 units: mint to alice, trade event; then a transfer to bob and an accrual
    blocks.bought = chain.mine([
      ev.transfer(ADDR.tokenCall, "0x0000000000000000000000000000000000000000", ADDR.alice, 3n * WAD),
      ev.bought(SERIES_CALL, ADDR.alice, ADDR.alice, 3n * WAD, 3n * WAD, 8_125_000n, 2_708_333_333_333_333_333n, 5100n, 0),
    ]);
    blocks.accrued = chain.mine([ev.accrued(SERIES_CALL, 996_000_000_000_000_000n, 2_700_000_000_000_000_000n, 1_000_000_000_000_000_000n, 1)]);
    blocks.moved = chain.mine([ev.transfer(ADDR.tokenCall, ADDR.alice, ADDR.bob, 1n * WAD)]);
    blocks.sold = chain.mine([
      ev.sold(SERIES_CALL, ADDR.bob, ADDR.carol, 1n * WAD, 1n * WAD, 2_500_000n, 2_500_000_000_000_000_000n, 5100n, 2),
      ev.transfer(ADDR.tokenCall, ADDR.bob, "0x0000000000000000000000000000000000000000", 1n * WAD),
    ]);
    blocks.shield = chain.mine([ev.shield(ADDR.alice, ADDR.nvda, SERIES_PUT, 2n * WAD, 1_234_567n)]);
    blocks.paused = chain.mine([ev.buysPaused(true, b32(0), true), ev.buysPaused(false, SERIES_PUT, true), ev.buysPaused(false, SERIES_PUT, false)]);

    const volTx = "vol";
    blocks.vol = chain.mine([{ ...ev.volPosted(ADDR.nvda, 0, 5200n, 15n, 300n, 1_790_007_200n, 7n), tx: volTx }]);
    chain.setTransactionInput(
      chain.txHashOf(blk("vol"), 0),
      encodeFunctionData({
        abi: VolOracleAbi,
        functionName: "post",
        args: [
          { stock: ADDR.nvda, speed: 0, sigmaBps: 5200n, skewK: 15n, eventBumpBps: 300n, buyBlockFrom: 1_790_100_000n, buyBlockTo: 1_790_150_000n, validUntil: 1_790_007_200n, nonce: 7n },
          "0x" + "ab".repeat(65) as Hex,
        ],
      }),
    );

    blocks.pool = chain.mine([
      ev.hedgeEquity(250_500_000n, 1_790_000_000n, b32(0x5eed)),
      ev.rebalanced(ADDR.nvda, true, 100n * BigInt(USDG), 2n * WAD, 2n * WAD),
      ev.rebalanced(ADDR.nvda, false, WAD / 2n, 52_000_000n, 3n * WAD / 2n),
      ev.cashRaised(ADDR.nvda, WAD / 4n, 26_000_000n),
      ev.hedgeUnitsSynced(ADDR.nvda, WAD),
      ev.poolDeposit(ADDR.alice, ADDR.alice, 100n * BigInt(USDG), 100n * 10n ** 12n),
      ev.withdrawalQueued(ADDR.alice, 1n, 40n * 10n ** 12n, 1_790_259_200n),
    ]);
    blocks.claimed = chain.mine([ev.withdrawalClaimed(ADDR.alice, 1n, 41_000_000n), ev.poolWithdraw(ADDR.alice, ADDR.alice, ADDR.alice, 41_000_000n, 40n * 10n ** 12n)]);
    blocks.queue = chain.mine([
      ev.sellQueued(1n, SERIES_CALL, ADDR.alice, ADDR.alice, WAD, 1_790_000_100n),
      ev.sellQueued(2n, SERIES_CALL, ADDR.bob, ADDR.bob, 2n * WAD, 1_790_000_101n),
    ]);
    blocks.queueClosed = chain.mine([ev.queuedFilled(1n, ADDR.carol, 2_000_000n), ev.queuedCancelled(2n)]);
    blocks.agent = chain.mine([ev.agentTrade(ADDR.alice, ADDR.agent, SERIES_CALL, true, 5_000_000n)]);
    blocks.routerSet = chain.mine([ev.policyStocks(ADDR.alice, ADDR.agent, [ADDR.nvda, ADDR.tsla])]);
    blocks.routerQueue = chain.mine([ev.sellQueued(7n, SERIES_CALL, ADDR.agentRouter, ADDR.agentRouter, WAD, 1_790_000_300n), ev.queuedSellFor(7n, ADDR.alice, ADDR.agent, SERIES_CALL)]);
    blocks.guard = chain.mine([ev.stockPaused(ADDR.nvda, true, ("0x" + Buffer.from("SPLIT").toString("hex").padEnd(64, "0")) as Hex)]);
    blocks.poolTransfer = chain.mine([ev.poolTransfer("0x0000000000000000000000000000000000000000", ADDR.alice, 100n * 10n ** 12n)]);

    // The chain agrees with the events: the snapshot's series reconciliation must leave them as they are.
    const reader = new FakeReader();
    reader.series[SERIES_CALL] = { norm: 996_000_000_000_000_000n, lastAccrual: BigInt(ts(blk("accrued")).getTime() / 1_000) };
    const { state } = await makeIndexer(db.sql, chain, { reader });
    await syncToHead(state);
  });
  afterAll(async () => db.close());

  test("SeriesListed and SeriesBuyableSet fill the series table", async () => {
    const series = await rows(db, "SELECT id, stock_token, name, feed, is_call, speed, tau_s, strike, token, buyable, archived, listed_block FROM series ORDER BY is_call DESC");
    expect(series).toEqual([
      { id: SERIES_CALL, stock_token: ADDR.nvda, name: "NVDA", feed: ADDR.nvdaFeed, is_call: true, speed: "WEEKLY", tau_s: 604800, strike: "110.000000000000000000", token: ADDR.tokenCall, buyable: true, archived: false, listed_block: String(blk("listed")) },
      { id: SERIES_PUT, stock_token: ADDR.nvda, name: "NVDA", feed: ADDR.nvdaFeed, is_call: false, speed: "DAILY", tau_s: 86400, strike: "90.000000000000000000", token: ADDR.tokenPut, buyable: true, archived: false, listed_block: String(blk("listed")) },
    ]);
  });

  test("Bought and Sold become trades with exact decimals", async () => {
    const trades = await rows(db, "SELECT side, account, recipient, units, shares, usdg, v_mark, sigma_bps, session, block FROM trades ORDER BY block");
    expect(trades).toEqual([
      { side: "buy", account: ADDR.alice, recipient: ADDR.alice, units: "3.000000000000000000", shares: "3.000000000000000000", usdg: "8.125000000000000000", v_mark: "2.708333333333333333", sigma_bps: 5100, session: "REGULAR", block: String(blk("bought")) },
      { side: "sell", account: ADDR.bob, recipient: ADDR.carol, units: "1.000000000000000000", shares: "1.000000000000000000", usdg: "2.500000000000000000", v_mark: "2.500000000000000000", sigma_bps: 5100, session: "CLOSED", block: String(blk("sold")) },
    ]);
  });

  test("Accrued writes norm_history and moves the series norm", async () => {
    const history = await rows(db, "SELECT series_id, norm, v_mark, payoff, session, ts FROM norm_history");
    expect(history).toEqual([
      { series_id: SERIES_CALL, norm: "0.996000000000000000", v_mark: "2.700000000000000000", payoff: "1.000000000000000000", session: "EXTENDED", ts: ts(blk("accrued")) },
    ]);
    const series = await rows(db, "SELECT norm, last_accrual FROM series WHERE id = '" + SERIES_CALL + "'");
    expect(series).toEqual([{ norm: "0.996000000000000000", last_accrual: ts(blk("accrued")) }]);
    const untouched = await rows(db, "SELECT norm FROM series WHERE id = '" + SERIES_PUT + "'");
    expect(untouched).toEqual([{ norm: "1.000000000000000000" }]);
  });

  test("ShieldBought is stored", async () => {
    expect(await rows(db, "SELECT account, stock_token, series_id, token_units, usdg_paid FROM shields")).toEqual([
      { account: ADDR.alice, stock_token: ADDR.nvda, series_id: SERIES_PUT, token_units: "2.000000000000000000", usdg_paid: "1.234567000000000000" },
    ]);
  });

  test("BuysPaused (global and per series) and the PriceGuard pause go to pause_log", async () => {
    expect(await rows(db, "SELECT scope, key, paused, reason FROM pause_log ORDER BY block, log_index")).toEqual([
      { scope: "global", key: "global", paused: true, reason: null },
      { scope: "series", key: SERIES_PUT, paused: true, reason: null },
      { scope: "series", key: SERIES_PUT, paused: false, reason: null },
      { scope: "stock", key: ADDR.nvda, paused: true, reason: "SPLIT" },
    ]);
  });

  test("VolPosted stores the post and the signature and buy-block window from the calldata", async () => {
    expect(await rows(db, "SELECT stock_token, name, speed, sigma_bps, skew_k, event_bump_bps, buy_block_from, buy_block_to, valid_until, nonce, sig FROM vol_posts")).toEqual([
      {
        stock_token: ADDR.nvda, name: "NVDA", speed: "DAILY", sigma_bps: 5200, skew_k: "15", event_bump_bps: 300,
        buy_block_from: new Date(1_790_100_000_000), buy_block_to: new Date(1_790_150_000_000),
        valid_until: new Date(1_790_007_200_000), nonce: "7", sig: "0x" + "ab".repeat(65),
      },
    ]);
  });

  test("HedgeEquityPosted is stored", async () => {
    expect(await rows(db, "SELECT equity_usdg, as_of, ref FROM hedge_equity_posts")).toEqual([
      { equity_usdg: "250.500000000000000000", as_of: new Date(1_790_000_000_000), ref: b32(0x5eed) },
    ]);
  });

  test("pool hedge events (Rebalanced, CashRaised, HedgeUnitsSynced) are stored with the stock and USDG sides split", async () => {
    expect(await rows(db, "SELECT kind, stock, side, stock_amount, usdg_amount, units_after FROM pool_hedge_events ORDER BY log_index")).toEqual([
      { kind: "rebalance", stock: ADDR.nvda, side: "buy", stock_amount: "2.000000000000000000", usdg_amount: "100.000000000000000000", units_after: "2.000000000000000000" },
      { kind: "rebalance", stock: ADDR.nvda, side: "sell", stock_amount: "0.500000000000000000", usdg_amount: "52.000000000000000000", units_after: "1.500000000000000000" },
      { kind: "cash_raised", stock: ADDR.nvda, side: "sell", stock_amount: "0.250000000000000000", usdg_amount: "26.000000000000000000", units_after: null },
      { kind: "units_synced", stock: ADDR.nvda, side: null, stock_amount: null, usdg_amount: null, units_after: "1.000000000000000000" },
    ]);
  });

  test("WithdrawalQueued then WithdrawalClaimed leave one claimed ticket", async () => {
    expect(await rows(db, "SELECT owner, ticket, shares, claimable_at, status, usdg FROM withdrawals")).toEqual([
      { owner: ADDR.alice, ticket: "1", shares: "40.000000000000000000", claimable_at: new Date(1_790_259_200_000), status: "claimed", usdg: "41.000000000000000000" },
    ]);
    expect(await rows(db, "SELECT kind, account, assets, shares FROM pool_events ORDER BY block")).toEqual([
      { kind: "deposit", account: ADDR.alice, assets: "100.000000000000000000", shares: "100.000000000000000000" },
      { kind: "withdraw", account: ADDR.alice, assets: "41.000000000000000000", shares: "40.000000000000000000" },
    ]);
  });

  test("queued sells: one filled, one cancelled", async () => {
    expect(await rows(db, "SELECT ticket, series_id, seller, tokens, status, filler, usdg_out FROM queued_sells ORDER BY ticket")).toEqual([
      { ticket: "1", series_id: SERIES_CALL, seller: ADDR.alice, tokens: "1.000000000000000000", status: "filled", filler: ADDR.carol, usdg_out: "2.000000000000000000" },
      { ticket: "2", series_id: SERIES_CALL, seller: ADDR.bob, tokens: "2.000000000000000000", status: "cancelled", filler: null, usdg_out: null },
      { ticket: "7", series_id: SERIES_CALL, seller: ADDR.agentRouter, tokens: "1.000000000000000000", status: "open", filler: null, usdg_out: null },
    ]);
  });

  test("PolicyStocks and QueuedSellFor are stored", async () => {
    expect(await rows(db, "SELECT owner, agent, stocks FROM agent_policy_stocks")).toEqual([
      { owner: ADDR.alice, agent: ADDR.agent, stocks: [ADDR.nvda, ADDR.tsla] },
    ]);
    expect(await rows(db, "SELECT ticket, owner, agent, series_id FROM router_tickets")).toEqual([
      { ticket: "7", owner: ADDR.alice, agent: ADDR.agent, series_id: SERIES_CALL },
    ]);
  });

  test("AgentTrade is stored", async () => {
    expect(await rows(db, "SELECT owner, agent, series_id, is_buy, usdg FROM agent_trades")).toEqual([
      { owner: ADDR.alice, agent: ADDR.agent, series_id: SERIES_CALL, is_buy: true, usdg: "5.000000000000000000" },
    ]);
  });

  test("option-token transfers (mints and burns included) rebuild balances; pool shares use their own decimals", async () => {
    expect(await rows(db, "SELECT series_id, from_addr, to_addr, amount FROM transfers WHERE token = '" + ADDR.tokenCall + "' ORDER BY block")).toHaveLength(3);
    const balances = await rows(db, "SELECT token, account, balance FROM balances ORDER BY token, account");
    expect(balances).toEqual([
      { token: ADDR.pool, account: ADDR.alice, balance: "100.000000000000000000" },
      { token: ADDR.tokenCall, account: ADDR.bob, balance: "0.000000000000000000" },
      { token: ADDR.tokenCall, account: ADDR.alice, balance: "2.000000000000000000" },
    ]);
  });

  test("accounts seen are recorded once with their first block", async () => {
    const accounts = await rows(db, "SELECT address, first_seen_block FROM account_metadata WHERE address IN ('" + ADDR.alice + "', '" + ADDR.carol + "') ORDER BY address");
    expect(accounts).toEqual([
      { address: ADDR.carol, first_seen_block: String(blk("sold")) },
      { address: ADDR.alice, first_seen_block: String(blk("bought")) },
    ].sort((x, y) => (x.address < y.address ? -1 : 1)));
  });

  test("the cursor and block hashes follow the ingested range", async () => {
    const cursor = await rows(db, "SELECT block FROM cursors WHERE name = 'main'");
    expect(cursor).toEqual([{ block: String(await chain.getHead()) }]);
    const hashes = await rows(db, "SELECT count(*)::int AS n FROM block_hashes");
    expect(Number(hashes[0]?.n)).toBeGreaterThan(0);
  });
});

suite("stock token events", () => {
  test("a multiplier update becomes a scheduled corporate action", async () => {
    const db = (await createTestDatabase("corp"))!;
    try {
      await applyMigrations(db);
      const chain = new FakeChain();
      const stockEvent: LogSpec = {
        address: ADDR.nvda,
        abi: [{ type: "event", name: "UIMultiplierUpdated", inputs: [
          { name: "oldMultiplier", type: "uint256", indexed: false },
          { name: "newMultiplier", type: "uint256", indexed: false },
          { name: "effectiveAtTimestamp", type: "uint256", indexed: false },
        ] }] as unknown as Abi,
        eventName: "UIMultiplierUpdated",
        args: { oldMultiplier: WAD, newMultiplier: 4n * WAD, effectiveAtTimestamp: 1_790_100_000n },
      };
      chain.mine([stockEvent]);
      const { state } = await makeIndexer(db.sql, chain);
      await syncToHead(state);
      expect(await rows(db, "SELECT symbol, kind, status, old_mult, new_mult FROM corp_actions")).toEqual([
        { symbol: "NVDA", kind: "ui_multiplier", status: "scheduled", old_mult: "1.000000000000000000", new_mult: "4.000000000000000000" },
      ]);
    } finally {
      await db.close();
    }
  });
});
