import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { is } from "drizzle-orm";
import { getTableConfig, PgTable } from "drizzle-orm/pg-core";
import * as schema from "./schema";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";

const enabled = Boolean(testDatabaseUrl());
const suite = enabled ? describe : describe.skip;

const NEW_TABLES = [
  "series", "series_flag_log", "trades", "shields", "agent_trades", "norm_history", "ticks", "vol_posts", "pool_nav",
  "limits_state", "hedges", "queued_sells", "withdrawals", "pool_events", "hedge_equity_posts", "pause_log", "transfers",
  "receipts", "block_hashes", "vol_post_intents", "vol_alerts",
];
const KEPT_TABLES = [
  "account_metadata", "balances", "corp_actions", "cursors", "earnings", "keeper_status", "market_launch", "ref_prices",
  "token_flow", "upcoming_subscriptions", "api_nonces", "invite_codes", "invite_redemptions", "app_settings",
];
const RETIRED_TABLES = ["markets", "vault_ticks", "vault_events", "vault_account_state", "regime_log", "carry_updates", "oracle_updates"];

async function tables(db: TestDatabase): Promise<Set<string>> {
  const rows = await db.sql`SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`;
  return new Set(rows.map((row) => String(row.table_name)));
}

async function columns(db: TestDatabase, table: string): Promise<string[]> {
  const rows = await db.sql`SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = ${table}`;
  return rows.map((row) => String(row.column_name));
}

suite("migrationsApplyFresh", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = (await createTestDatabase("fresh"))!;
    await applyMigrations(db);
  });
  afterAll(async () => db.close());

  test("every spec table exists and the retired product tables are gone", async () => {
    const present = await tables(db);
    for (const name of [...NEW_TABLES, ...KEPT_TABLES]) expect(present.has(name), name).toBe(true);
    for (const name of RETIRED_TABLES) expect(present.has(name), name).toBe(false);
  });

  test("spec columns are present", async () => {
    expect(await columns(db, "series")).toEqual(expect.arrayContaining(["id", "stock_token", "feed", "is_call", "strike", "tau_s", "token", "norm", "last_accrual", "buyable", "listed_at"]));
    expect(await columns(db, "trades")).toEqual(expect.arrayContaining(["series_id", "account", "side", "units", "shares", "usdg", "v_mark", "sigma_bps", "session", "tx_hash", "ts"]));
    expect(await columns(db, "norm_history")).toEqual(expect.arrayContaining(["series_id", "ts", "norm", "v_mark", "payoff"]));
    expect(await columns(db, "vol_posts")).toEqual(expect.arrayContaining(["stock_token", "speed", "sigma_bps", "skew_k", "event_bump_bps", "valid_until", "sig", "ts"]));
    expect(await columns(db, "pool_nav")).toEqual(expect.arrayContaining(["ts", "usdg", "hedge_equity", "option_liability", "reserve", "nav_per_share"]));
    expect(await columns(db, "hedges")).toEqual(expect.arrayContaining(["id", "venue", "name", "side", "qty", "px", "ts", "venue_ref"]));
    expect(await columns(db, "limits_state")).toEqual(expect.arrayContaining(["name", "net_delta", "net_gamma", "net_vega", "stress_loss_bps", "ts"]));
  });

  test("schema.ts describes exactly the tables and columns the migrations create", async () => {
    const declared = Object.values(schema).filter((value) => is(value, PgTable)) as unknown as PgTable[];
    expect(declared.length).toBeGreaterThan(20);
    for (const table of declared) {
      const config = getTableConfig(table);
      const actual = (await columns(db, config.name)).sort();
      expect(actual.length, `table ${config.name} exists`).toBeGreaterThan(0);
      expect(config.columns.map((column) => column.name).sort(), config.name).toEqual(actual);
    }
    // and nothing exists in the database that schema.ts does not know about
    const known = new Set<string>(declared.map((table) => getTableConfig(table).name));
    const unknown = [...(await tables(db))].filter((name) => !known.has(name) && name !== "__drizzle_migrations");
    expect(unknown).toEqual([]);
  });

  test("norm_history and ticks are hypertables when TimescaleDB is installed", async () => {
    if (!db.timescale) return;
    const rows = await db.sql`SELECT hypertable_name FROM timescaledb_information.hypertables`;
    const names = new Set(rows.map((row) => String(row.hypertable_name)));
    expect(names.has("norm_history")).toBe(true);
    expect(names.has("ticks")).toBe(true);
  });

  test("the series id and tx/log keys reject duplicates", async () => {
    await db.sql`INSERT INTO trades (tx_hash, log_index, block, ts, series_id, account, recipient, side, units, shares, usdg, v_mark, sigma_bps, session)
      VALUES ('0xaa', 1, 1, now(), '0x01', '0xa', '0xa', 'buy', 1, 1, 1, 1, 5000, 'REGULAR')`;
    let message = "";
    try {
      await db.sql`INSERT INTO trades (tx_hash, log_index, block, ts, series_id, account, recipient, side, units, shares, usdg, v_mark, sigma_bps, session)
        VALUES ('0xaa', 1, 1, now(), '0x01', '0xa', '0xa', 'buy', 1, 1, 1, 1, 5000, 'REGULAR')`;
    } catch (error) {
      message = String(error);
    }
    expect(message).toContain("duplicate key");
  });
});

suite("migrationsApplyOnOld", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = (await createTestDatabase("old"))!;
    await applyMigrations(db, 8); // 0000..0007: the power-payoff schema
  });
  afterAll(async () => db.close());

  test("migrates a populated old database forward and keeps the surviving tables' data", async () => {
    expect((await tables(db)).has("markets")).toBe(true);
    await db.sql`INSERT INTO markets (id, symbol, token, stock, feed, scale, pool_fee, listed_block, config) VALUES (0, 'OLD', '0x1', '0x2', '0x3', 1, 500, 1, '{}')`;
    await db.sql`INSERT INTO trades (tx_hash, log_index, block, ts, market_id, account, recipient, side, usdg, fee, tokens, price, "index", norm_factor)
      VALUES ('0xold', 0, 1, now(), 0, '0xa', '0xa', 'buy', 1, 0, 1, 1, 1, 1)`;
    await db.sql`INSERT INTO balances (token, account, balance, updated_block) VALUES ('0xtoken', '0xa', 5, 1)`;
    await db.sql`INSERT INTO keeper_status (job, last_ok) VALUES ('indexer', now())`;
    await db.sql`INSERT INTO earnings (symbol, report_date, session, source) VALUES ('NVDA', '2026-11-19', 'post', 'test')`;
    await db.sql`INSERT INTO cursors (name, block) VALUES ('main', 123)`;

    await applyMigrations(db);

    const present = await tables(db);
    for (const name of [...NEW_TABLES, ...KEPT_TABLES]) expect(present.has(name), name).toBe(true);
    for (const name of RETIRED_TABLES) expect(present.has(name), name).toBe(false);
    expect(await columns(db, "trades")).toContain("series_id");
    expect(await columns(db, "trades")).not.toContain("market_id");
    expect((await db.sql`SELECT count(*)::int AS n FROM trades`)[0]?.n).toBe(0);
    expect((await db.sql`SELECT count(*)::int AS n FROM balances`)[0]?.n).toBe(0);
    expect((await db.sql`SELECT count(*)::int AS n FROM keeper_status`)[0]?.n).toBe(1);
    expect((await db.sql`SELECT count(*)::int AS n FROM earnings`)[0]?.n).toBe(1);
    expect((await db.sql`SELECT count(*)::int AS n FROM cursors`)[0]?.n).toBe(0);
  });
});
