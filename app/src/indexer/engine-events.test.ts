// Review F07/F08/F21/F24 and decision 30-32 follow-up: the engine's retirement, ORC-4 settlement, halt latch and the
// hold a transfer carries are indexed and shown in the activity of the accounts they concern.
import { describe, expect, test } from "bun:test";
import { accountActivity } from "../db/queries/activity";
import { applyMigrations, createTestDatabase, testDatabaseUrl } from "../testing/db";
import { ADDR, FakeChain, FakeReader, SERIES_CALL, ev, makeIndexer, syncToHead } from "./test-support";

const suite = testDatabaseUrl() ? describe : describe.skip;
const WAD = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

suite("engine safety events", () => {
  test("retirement, settlement, the halt latch and carried holds are stored and reach the holders' activity", async () => {
    const db = (await createTestDatabase("engine_events"))!;
    try {
      await applyMigrations(db);
      const chain = new FakeChain();
      chain.mine([ev.seriesListed(SERIES_CALL, ADDR.nvda, true, 1, 110n * WAD, ADDR.tokenCall)]);
      const reader = new FakeReader();
      const far = BigInt(Math.floor(Date.now() / 1000)) + 10n ** 9n;
      reader.holds[`${SERIES_CALL}:${ADDR.alice}`] = { until: far, sWad: 118n * WAD };
      const { state } = await makeIndexer(db.sql, chain, { reader });
      chain.mine([ev.transfer(ADDR.tokenCall, ZERO, ADDR.alice, 3n * WAD), ev.bought(SERIES_CALL, ADDR.alice, ADDR.alice, 3n * WAD, 3n * WAD, 8_000_000n, WAD)]);
      await syncToHead(state); // the snapshot stores alice's hold
      chain.mine([ev.transfer(ADDR.tokenCall, ADDR.alice, ADDR.bob, WAD)]);
      chain.mine([ev.haltLatched(ADDR.nvda, 1_790_000_100n), ev.stockSettled(ADDR.nvda, 117n * WAD), ev.seriesRetired(SERIES_CALL)]);
      // a transfer in the same batch as the buy: carried by the recent-buy rule before any snapshot saw the hold
      chain.mine([
        ev.transfer(ADDR.tokenCall, ZERO, ADDR.carol, WAD), ev.bought(SERIES_CALL, ADDR.carol, ADDR.carol, WAD, WAD, 3_000_000n, WAD),
        ev.transfer(ADDR.tokenCall, ADDR.carol, ADDR.dave, WAD / 2n),
      ]);
      await syncToHead(state);

      const stored = await db.sql`SELECT kind, series_id, stock_token, account, price::text AS price FROM engine_events ORDER BY block, log_index`;
      expect(stored.map((row) => [row.kind, row.account])).toEqual([
        ["hold_carried", ADDR.bob], ["halt_latched", null], ["stock_settled", null], ["series_retired", null], ["hold_carried", ADDR.dave],
      ]);
      expect(stored[0]!.price).toBe("118.000000000000000000");
      expect(stored[2]!.price).toBe("117.000000000000000000");
      expect(stored[4]!.price).toBeNull(); // buy-time S not indexed yet; the snapshot reads the exact hold

      const bob = (await accountActivity({ sql: db.sql } as never, ADDR.bob, { limit: 50 })).items;
      const kinds: string[] = bob.map((item) => item.kind);
      for (const kind of ["hold_carried", "halt_latched", "stock_settled", "series_retired"]) expect(kinds).toContain(kind);
      expect(bob.find((item) => item.kind === "stock_settled")!.name).toBe("NVDA");
      // an account with no position in the name sees none of the market-wide events
      const stranger = (await accountActivity({ sql: db.sql } as never, "0x00000000000000000000000000000000000fffff", { limit: 50 })).items;
      expect(stranger).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
