import postgres from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";
import type { RuntimeConfig } from "../config";
import * as schema from "./schema";

export interface DbClientOptions {
  /** Open every session with default_transaction_read_only, so the public API
   * cannot write even if a query tries to. Pair it with a SELECT-only role. */
  readonly readOnly?: boolean;
}

export function createDbClient(config: Pick<RuntimeConfig, "DATABASE_URL">, options: DbClientOptions = {}) {
  const sql = postgres(config.DATABASE_URL, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
    transform: { undefined: null },
    ...(options.readOnly ? { connection: { default_transaction_read_only: true } } : {}),
  });
  const db = drizzle(sql, { schema });
  return { db, sql };
}

export type LemniscateDbClient = ReturnType<typeof createDbClient>;
