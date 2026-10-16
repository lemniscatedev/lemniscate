import { cpSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres, { type Sql } from "postgres";

export const MIGRATIONS_DIR = resolve(import.meta.dir, "../../drizzle");

/** The URL of the throwaway (or caller supplied) server, or undefined when database tests must be skipped. */
export function testDatabaseUrl(): string | undefined {
  return process.env.TEST_DATABASE_URL || undefined;
}

export interface TestDatabase {
  readonly sql: Sql;
  readonly name: string;
  readonly timescale: boolean;
  readonly close: () => Promise<void>;
}

/** A tiny stand-in for the TimescaleDB functions the migrations call, for servers without the extension. It only has
 * to make the real migration SQL run; it does not partition anything. Production and CI-with-Timescale use the real
 * extension, where the `timescaledb.continuous` option and the policies are honoured. */
const TIMESCALE_SHIM = `
CREATE OR REPLACE FUNCTION create_hypertable(rel text, time_col text, chunk_time_interval interval DEFAULT NULL, if_not_exists boolean DEFAULT false)
  RETURNS void LANGUAGE sql AS 'SELECT';
CREATE OR REPLACE FUNCTION add_continuous_aggregate_policy(rel text, start_offset interval DEFAULT NULL, end_offset interval DEFAULT NULL, schedule_interval interval DEFAULT NULL)
  RETURNS void LANGUAGE sql AS 'SELECT';
CREATE OR REPLACE FUNCTION add_retention_policy(rel text, drop_after interval DEFAULT NULL)
  RETURNS void LANGUAGE sql AS 'SELECT';
CREATE OR REPLACE FUNCTION time_bucket(bucket interval, ts timestamptz)
  RETURNS timestamptz LANGUAGE sql IMMUTABLE AS $$ SELECT date_bin(bucket, ts, TIMESTAMPTZ '2000-01-01') $$;
CREATE OR REPLACE FUNCTION shim_first_step(state anyelement, val anyelement, ts timestamptz) RETURNS anyelement LANGUAGE sql IMMUTABLE AS 'SELECT COALESCE(state, val)';
CREATE OR REPLACE FUNCTION shim_last_step(state anyelement, val anyelement, ts timestamptz) RETURNS anyelement LANGUAGE sql IMMUTABLE AS 'SELECT val';
CREATE AGGREGATE first(anyelement, timestamptz) (SFUNC = shim_first_step, STYPE = anyelement);
CREATE AGGREGATE last(anyelement, timestamptz) (SFUNC = shim_last_step, STYPE = anyelement);
`;

async function hasTimescale(sql: Sql): Promise<boolean> {
  const rows = await sql`SELECT 1 FROM pg_available_extensions WHERE name = 'timescaledb'`;
  return rows.length > 0;
}

function withoutTimescale(statementSql: string): string {
  return statementSql
    .replace(/CREATE EXTENSION IF NOT EXISTS timescaledb;/g, "SELECT 1;")
    .replace(/WITH \(timescaledb\.continuous\)/g, "");
}

/** Creates an empty database on the test server. Every test file gets its own, so files cannot interfere. */
export async function createTestDatabase(label: string): Promise<TestDatabase | undefined> {
  const url = testDatabaseUrl();
  if (!url) return undefined;
  const admin = postgres(url, { max: 1, onnotice: () => undefined });
  const name = `t_${label.replace(/[^a-z0-9]/gi, "_").toLowerCase()}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  await admin.unsafe(`CREATE DATABASE ${name}`);
  await admin.end({ timeout: 5 });
  const target = new URL(url);
  target.pathname = `/${name}`;
  const sql = postgres(target.toString(), { max: 4, onnotice: () => undefined, transform: { undefined: null } });
  const timescale = await hasTimescale(sql);
  if (!timescale) await sql.unsafe(TIMESCALE_SHIM);
  return {
    sql,
    name,
    timescale,
    close: async () => {
      await sql.end({ timeout: 5 });
      const cleanup = postgres(url, { max: 1, onnotice: () => undefined });
      await cleanup.unsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await cleanup.end({ timeout: 5 });
    },
  };
}

/** Runs the real drizzle migrator over the repo's migration files. `upTo` stops after that many migrations (so a test
 * can build an "old" database and migrate it forward). Without TimescaleDB the SQL is lightly rewritten first. */
export async function applyMigrations(db: TestDatabase, upTo?: number): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "lmns-migrations-"));
  try {
    cpSync(MIGRATIONS_DIR, dir, { recursive: true });
    if (!db.timescale) {
      for (const file of readdirSync(dir)) {
        if (!file.endsWith(".sql")) continue;
        const path = join(dir, file);
        writeFileSync(path, withoutTimescale(readFileSync(path, "utf8")));
      }
    }
    if (upTo !== undefined) {
      const journalPath = join(dir, "meta", "_journal.json");
      const journal = JSON.parse(readFileSync(journalPath, "utf8")) as { entries: unknown[] };
      journal.entries = journal.entries.slice(0, upTo);
      writeFileSync(journalPath, JSON.stringify(journal));
    }
    await migrate(drizzle(db.sql), { migrationsFolder: dir });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
