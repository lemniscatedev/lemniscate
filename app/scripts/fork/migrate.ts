// Migrations for the fork database. Uses the real TimescaleDB extension when the server has it; otherwise the same
// stand-in the test suite uses (src/testing/db.ts: no partitioning, same SQL), so the fork runs on a plain Homebrew
// Postgres. The fork report says which one ran.
import postgres from "postgres";
import { applyMigrations } from "@/testing/db";
import { DATABASE_URL } from "./lib";

const sql = postgres(DATABASE_URL, { max: 2, onnotice: () => undefined, transform: { undefined: null } });
try {
  const timescale = (await sql`select 1 from pg_available_extensions where name = 'timescaledb'`).length > 0;
  if (!timescale && (await sql`select 1 from pg_proc where proname = 'shim_first_step'`).length === 0) {
    await sql.unsafe((await import("@/testing/db")).TIMESCALE_SHIM);
  }
  await applyMigrations({ sql, name: "lemniscate_fork", timescale, close: async () => undefined });
  console.log(`migrate: done (${timescale ? "TimescaleDB" : "TimescaleDB stand-in, extension not installed"})`);
} finally {
  await sql.end({ timeout: 5 });
}
