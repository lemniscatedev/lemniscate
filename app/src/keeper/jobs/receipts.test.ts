import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../../testing/db";
import { EMPTY_ROOT, merkleRoot, verifyMerkleProof } from "../merkle";
import { navLeaf, tradeLeaf, volPostLeaf } from "../receipts-leaves";
import { closeHours, loadHourLeaves, proveLeaf } from "./receipts";

const H = (iso: string) => new Date(iso);
const hex = (n: number) => `0x${n.toString(16).padStart(64, "0")}`;
const addr = (n: number) => `0x${n.toString(16).padStart(40, "0")}`;

const enabled = Boolean(testDatabaseUrl());
(enabled ? describe : describe.skip)("receipts", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = (await createTestDatabase("receipts"))!;
    await applyMigrations(db);
    // hour 12:00-13:00: two trades, one vol post, two NAV snapshots; hour 13:00-14:00: one trade
    for (const [i, ts] of ["2026-10-16T12:05:00Z", "2026-10-16T12:59:59Z", "2026-10-16T13:00:00Z"].entries()) {
      await db.sql`insert into trades (tx_hash, log_index, block, ts, series_id, account, recipient, side, units, shares, usdg, v_mark, sigma_bps, session)
        values (${hex(i + 1)}, ${i}, ${100 + i}, ${ts}, ${hex(99)}, ${addr(1)}, ${addr(1)}, ${i % 2 ? "sell" : "buy"}, 3, 3, 8.125, 2.708333333333333333, 5200, 'REGULAR')`;
    }
    await db.sql`insert into vol_posts (tx_hash, log_index, block, ts, stock_token, name, speed, sigma_bps, skew_k, event_bump_bps, buy_block_from, buy_block_to, valid_until, nonce)
      values (${hex(50)}, 0, 101, ${"2026-10-16T12:30:00Z"}, ${addr(7)}, 'NVDA', 'DAILY', 5200, 15, 300, null, null, ${"2026-10-16T14:30:00Z"}, 4)`;
    for (const [i, ts] of ["2026-10-16T12:10:00Z", "2026-10-16T12:40:00Z"].entries()) {
      await db.sql`insert into pool_nav (ts, block, usdg, hedge_equity, option_liability, reserve, nav, nav_per_share)
        values (${ts}, ${200 + i}, 1000, 0, 12.5, 5, ${i ? -3 : 987.5}, 1.01)`;
    }
  });
  afterAll(async () => { await db.close(); });

  test("closes finished hours only, once the indexer has passed them, and an empty hour has the zero root", async () => {
    // chain time 14:20 -> hours up to 14:00 are closable; first run looks 24h back (all empty before 12:00)
    const early = await closeHours(db.sql, H("2026-10-16T14:20:00Z"), H("2026-10-16T12:30:00Z"));
    expect(early.length).toBe(22); // indexed only to 12:30: the 12:00 hour is not final yet
    expect((await db.sql`select 1 from receipts where period_start = ${"2026-10-16T12:00:00Z"}`).length).toBe(0);
    const closed = await closeHours(db.sql, H("2026-10-16T14:20:00Z"), H("2026-10-16T14:10:00Z"));
    expect(closed.length).toBe(2);
    const rows = await db.sql`select period_start, root, leaf_count, trades_count, vol_posts_count, nav_count from receipts order by period_start`;
    expect(rows.length).toBe(24);
    const noon = rows.find((r) => new Date(r.period_start).toISOString() === "2026-10-16T12:00:00.000Z")!;
    expect([noon.leaf_count, noon.trades_count, noon.vol_posts_count, noon.nav_count]).toEqual([5, 2, 1, 2]);
    expect(rows[0]!.root).toBe(EMPTY_ROOT);
    expect((await closeHours(db.sql, H("2026-10-16T14:20:00Z"), H("2026-10-16T14:10:00Z"))).length).toBe(0);
  });

  test("the stored root equals the root of the hour's leaves and every leaf proves against it", async () => {
    const start = H("2026-10-16T12:00:00Z");
    const leaves = await loadHourLeaves(db.sql, start);
    expect(leaves.trades.length).toBe(2);
    const stored = (await db.sql`select root from receipts where period_start = ${start.toISOString()}`)[0]!.root as `0x${string}`;
    expect(merkleRoot(leaves.all)).toBe(stored);
    for (const leaf of leaves.all) {
      const proof = await proveLeaf(db.sql, start, leaf);
      expect(proof?.verified).toBe(true);
      expect(verifyMerkleProof(leaf, proof!.proof, stored)).toBe(true);
    }
    expect(await proveLeaf(db.sql, start, hex(12345) as `0x${string}`)).toBeUndefined();
  });

  test("leaf encoding is deterministic and sensitive to every field", async () => {
    const start = H("2026-10-16T12:00:00Z");
    const { trades, volPosts, navs } = await loadHourLeaves(db.sql, start);
    expect(tradeLeaf(trades[0]!.row)).toBe(trades[0]!.leaf);
    expect(tradeLeaf({ ...trades[0]!.row, usdg: "8.125001" })).not.toBe(trades[0]!.leaf);
    expect(tradeLeaf({ ...trades[0]!.row, side: trades[0]!.row.side === "buy" ? "sell" : "buy" })).not.toBe(trades[0]!.leaf);
    expect(volPostLeaf({ ...volPosts[0]!.row, sigma_bps: 5201 })).not.toBe(volPosts[0]!.leaf);
    expect(navLeaf({ ...navs[0]!.row, nav: "-3.000000000000000001" })).not.toBe(navs[0]!.leaf);
    // a negative NAV encodes (int256)
    expect(navs.some((n) => n.row.nav.startsWith("-"))).toBe(true);
    // editing a stored trade after the root was written makes the proof refuse
    await db.sql`update trades set usdg = 9 where tx_hash = ${hex(1)}`;
    expect(await proveLeaf(db.sql, start, trades[1]!.leaf)).toBeUndefined();
  });
});
