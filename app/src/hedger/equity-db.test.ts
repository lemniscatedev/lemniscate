import { describe, expect, test } from "bun:test";
import { drizzle } from "drizzle-orm/postgres-js";
import { applyMigrations, createTestDatabase, testDatabaseUrl } from "../testing/db";
import { lastEquityPostAsOf } from "./equity";

const suite = testDatabaseUrl() ? describe : describe.skip;

suite("lastEquityPostAsOf (todo 23 fork bug: the equity job crashed once a post existed)", () => {
  test("reads the newest as_of in unix seconds through a drizzle-wrapped client (timestamps come back as strings)", async () => {
    const db = (await createTestDatabase("hedger-equity"))!;
    try {
      await applyMigrations(db);
      drizzle(db.sql); // the services always wrap the client; drizzle replaces the timestamp parsers with strings
      expect(await lastEquityPostAsOf(db.sql)).toBe(0);
      await db.sql`insert into hedge_equity_posts (tx_hash, log_index, block, ts, equity_usdg, as_of, ref)
        values ('0x1', 0, 1, now(), 0, to_timestamp(1792186687), '0xr'), ('0x2', 0, 2, now(), 0, to_timestamp(1792180000), '0xr')`;
      expect(await lastEquityPostAsOf(db.sql)).toBe(1792186687);
    } finally {
      await db.close();
    }
  });
});
