import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { pino } from "pino";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import { handleEvents } from "./handlers";
import { ADDR, FakeChain, SERIES_CALL, b32, ev, makeIndexer, syncToHead } from "./test-support";
import type { ChainEvent, IndexerContext } from "./types";
import { MAX_DB_UNIX_SECONDS, unixToDate } from "./units";

const enabled = Boolean(testDatabaseUrl());
const suite = enabled ? describe : describe.skip;

const UINT64_MAX = 2n ** 64n - 1n;
const YEAR_10000 = 253_402_300_800n;

describe("unixToDate clamps instead of throwing (F04)", () => {
  test("uint64 max and year 10000 become the last representable second", () => {
    expect(unixToDate(UINT64_MAX).toISOString()).toBe("9999-12-31T23:59:59.000Z");
    expect(unixToDate(YEAR_10000).toISOString()).toBe("9999-12-31T23:59:59.000Z");
    expect(unixToDate(MAX_DB_UNIX_SECONDS).toISOString()).toBe("9999-12-31T23:59:59.000Z");
    expect(unixToDate(1_790_000_000n).toISOString()).toBe(new Date(1_790_000_000_000).toISOString());
  });
});

suite("F04 one bad event never halts the indexer", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = (await createTestDatabase("poison"))!;
    await applyMigrations(db);
  });
  afterAll(async () => db.close());

  test("the reviewer's setPolicy payload (expiresAt = uint64 max, and year 10000) is stored and the cursor advances past it", async () => {
    const chain = new FakeChain();
    chain.mine([ev.seriesListed(SERIES_CALL, ADDR.nvda, true, 1, 110n * 10n ** 18n, ADDR.tokenCall)]);
    const poison = chain.mine([
      ev.policySet(ADDR.bob, ADDR.agent, 0n, 0n, UINT64_MAX, false, false),
      ev.policySet(ADDR.carol, ADDR.agent, 0n, 0n, YEAR_10000, false, false),
    ]);
    const after = chain.mine([ev.agentTrade(ADDR.alice, ADDR.agent, SERIES_CALL, true, 5_000_000n)]);
    const { state } = await makeIndexer(db.sql, chain);
    await syncToHead(state);
    expect(state.cursor >= after).toBe(true);
    const policies = await db.sql`SELECT owner, expires_at FROM agent_policy_events ORDER BY log_index`;
    expect(policies.length).toBe(2);
    expect(new Date(policies[0]!.expires_at as string).getUTCFullYear()).toBe(9999);
    expect(poison < after).toBe(true);
    const trades = await db.sql`SELECT count(*)::int AS n FROM agent_trades`;
    expect(trades[0]!.n).toBe(1);
    const skipped = await db.sql`SELECT count(*)::int AS n FROM indexer_skipped_events`;
    expect(skipped[0]!.n).toBe(0);
  });

  test("an event whose handler throws is recorded in indexer_skipped_events and the rest of the batch still applies", async () => {
    const base = {
      txHash: "0x" + "aa".repeat(32), logIndex: 0, blockNumber: 500n, ts: new Date(1_790_000_000_000), address: ADDR.agentRouter,
    };
    const bad = { ...base, source: "agentRouter", eventName: "PolicySet", args: new Proxy({}, { get: () => { throw new Error("boom: unexpected event shape"); } }) } as unknown as ChainEvent;
    const good = { ...base, txHash: "0x" + "bb".repeat(32), blockNumber: 501n, source: "agentRouter", eventName: "AgentTrade", args: { owner: ADDR.alice, agent: ADDR.agent, seriesId: SERIES_CALL, isBuy: true, usdg: 5_000_000n } } as unknown as ChainEvent;
    const tail = { ...good, txHash: "0x" + "cc".repeat(32), logIndex: 1 } as ChainEvent;
    await db.sql.begin(async (tx) => {
      const context = {
        tx, logger: pino({ level: "silent" }), touchedBalances: new Map(), newSeries: [], kinds: new Set<string>(),
        snapshotNeeded: false, seriesRefreshNeeded: false,
      } as unknown as IndexerContext;
      await handleEvents(context, [bad, good, tail]);
    });
    const skipped = await db.sql`SELECT tx_hash, source, event_name, reason FROM indexer_skipped_events`;
    expect(skipped.length).toBe(1);
    expect(skipped[0]!.event_name).toBe("PolicySet");
    expect(String(skipped[0]!.reason).length).toBeGreaterThan(0);
    const trades = await db.sql`SELECT count(*)::int AS n FROM agent_trades WHERE block IN (501)`;
    expect(trades[0]!.n).toBe(2);
    const policy = await db.sql`SELECT count(*)::int AS n FROM agent_policy_events WHERE block = 500`;
    expect(policy[0]!.n).toBe(0);
  });
});
