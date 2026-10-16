import { describe, expect, test } from "bun:test";
import { applyMigrations, createTestDatabase, testDatabaseUrl } from "../testing/db";
import { loadBook, netDeltaFromBook } from "./netdelta";

const suite = testDatabaseUrl() ? describe : describe.skip;

suite("loadBook (R1, database)", () => {
  test("series x supply x norm with the latest tick's spot and per-speed sigma", async () => {
    const db = (await createTestDatabase("hedger-book"))!;
    try {
      await applyMigrations(db);
      const sql = db.sql;
      const stock = "0x0000000000000000000000000000000000002001";
      const when = new Date().toISOString();
      const whenMs = new Date(when).getTime();
      await sql`insert into series (id, stock_token, name, is_call, speed, tau_s, strike, token, norm, last_accrual, listed_at, listed_block, listed_tx, listed_log)
        values ('0xs1', ${stock}, 'NVDA', true, 'DAILY', 86400, 100, '0xtok1', 0.5, ${when}, ${when}, 1, '0xtx', 0),
               ('0xs2', ${stock}, 'NVDA', false, 'WEEKLY', 604800, 100, '0xtok2', 1, ${when}, ${when}, 1, '0xtx', 1)`;
      await sql`insert into balances (token, account, balance, updated_block) values ('0xtok1','0xa',30,1), ('0xtok1','0xb',10,1), ('0xtok2','0xa',0,1)`;
      await sql`insert into ticks (stock_token, name, ts, block, spot, session, fresh, sigma_daily_bps, sigma_weekly_bps) values
        (${stock}, 'NVDA', ${new Date(whenMs - 3_600_000).toISOString()}, 1, 90, 'REGULAR', true, 4000, 4000),
        (${stock}, 'NVDA', ${when}, 2, 100, 'REGULAR', true, 5000, 4500)`;
      const book = await loadBook(sql, whenMs + 5000);
      expect(book.series).toHaveLength(1); // the put has no supply
      expect(book.series[0]).toMatchObject({ id: "0xs1", isCall: true, speed: "DAILY", units: 20, strike: 100 });
      expect(book.markets.get(stock)).toMatchObject({ spot: 100, session: "REGULAR", fresh: true, sigma: { DAILY: 0.5, WEEKLY: 0.45 } });
      expect(book.markets.get(stock)!.tickAgeMs).toBeGreaterThanOrEqual(5000);
      const exposure = netDeltaFromBook(book.series, book.markets).get(stock)!;
      expect(exposure.complete).toBe(true);
      expect(exposure.netDelta).toBeGreaterThan(9);
      expect(exposure.netDelta).toBeLessThan(11);
    } finally {
      await db.close();
    }
  });
});
