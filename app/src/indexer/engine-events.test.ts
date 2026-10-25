// Review F07/F08/F21/F24 and decision 30-32 follow-up: the engine's retirement, ORC-4 settlement and halt latch are indexed
// and shown in the activity of the accounts they concern. R02 (decision 54, 28-merge): a transfer never carries a hold any
// more (held tokens cannot move), so no hold_carried event is written; the snapshot stores each hold's token count.
import { describe, expect, test } from "bun:test";
import { accountActivity } from "../db/queries/activity";
import { applyMigrations, createTestDatabase, testDatabaseUrl } from "../testing/db";
import { ADDR, FakeChain, FakeReader, SERIES_CALL, ev, makeIndexer, syncToHead } from "./test-support";

const suite = testDatabaseUrl() ? describe : describe.skip;
const WAD = 10n ** 18n;
const ZERO = "0x0000000000000000000000000000000000000000" as const;

suite("engine safety events", () => {
  test("retirement, settlement and the halt latch are stored and reach the holders' activity; transfers carry no hold", async () => {
    const db = (await createTestDatabase("engine_events"))!;
    try {
      await applyMigrations(db);
      const chain = new FakeChain();
      chain.mine([ev.seriesListed(SERIES_CALL, ADDR.nvda, true, 1, 110n * WAD, ADDR.tokenCall)]);
      const reader = new FakeReader();
      const far = BigInt(Math.floor(Date.now() / 1000)) + 10n ** 9n;
      reader.holds[`${SERIES_CALL}:${ADDR.alice}`] = { until: far, sWad: 118n * WAD, tokensWad: 2n * WAD };
      const { state } = await makeIndexer(db.sql, chain, { reader });
      chain.mine([ev.transfer(ADDR.tokenCall, ZERO, ADDR.alice, 3n * WAD), ev.bought(SERIES_CALL, ADDR.alice, ADDR.alice, 3n * WAD, 3n * WAD, 8_000_000n, WAD)]);
      await syncToHead(state); // the snapshot stores alice's hold
      chain.mine([ev.transfer(ADDR.tokenCall, ADDR.alice, ADDR.bob, WAD)]);
      chain.mine([ev.haltLatched(ADDR.nvda, 1_790_000_100n), ev.stockSettled(ADDR.nvda, 117n * WAD), ev.seriesRetired(SERIES_CALL)]);
      // a transfer in the same batch as a buy: no hold moves with it
      chain.mine([
        ev.transfer(ADDR.tokenCall, ZERO, ADDR.carol, WAD), ev.bought(SERIES_CALL, ADDR.carol, ADDR.carol, WAD, WAD, 3_000_000n, WAD),
        ev.transfer(ADDR.tokenCall, ADDR.carol, ADDR.dave, WAD / 2n),
      ]);
      await syncToHead(state);

      const stored = await db.sql`SELECT kind, series_id, stock_token, account, price::text AS price FROM engine_events ORDER BY block, log_index`;
      expect(stored.map((row) => [row.kind, row.account])).toEqual([
        ["halt_latched", null], ["stock_settled", null], ["series_retired", null],
      ]);
      expect(stored[1]!.price).toBe("117.000000000000000000");
      const holds = await db.sql`SELECT account, s::text AS s, tokens::text AS tokens FROM holds ORDER BY account`;
      expect(holds.map((row) => ({ ...row }))).toEqual([{ account: ADDR.alice, s: "118.000000000000000000", tokens: "2.000000000000000000" }]);
      // transfer receivers are not hold candidates (only buyers are)
      expect(reader.holdPairs.some((pair) => pair.endsWith(ADDR.bob) || pair.endsWith(ADDR.dave))).toBe(false);

      const bob = (await accountActivity({ sql: db.sql } as never, ADDR.bob, { limit: 50 })).items;
      const kinds: string[] = bob.map((item) => item.kind);
      for (const kind of ["halt_latched", "stock_settled", "series_retired"]) expect(kinds).toContain(kind);
      expect(kinds).not.toContain("hold_carried");
      expect(bob.find((item) => item.kind === "stock_settled")!.name).toBe("NVDA");
      // an account with no position in the name sees none of the market-wide events
      const stranger = (await accountActivity({ sql: db.sql } as never, "0x00000000000000000000000000000000000fffff", { limit: 50 })).items;
      expect(stranger).toEqual([]);
    } finally {
      await db.close();
    }
  });
});
