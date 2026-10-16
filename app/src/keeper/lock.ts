import postgres from "postgres";
import type { Logger } from "pino";
import { setTimeout as sleep } from "node:timers/promises";
import { safeErrorSummary } from "../log";

// Fixed advisory-lock key pair ("LEMNISCATE", keeper signer). Only the session that
// holds it may sign keeper transactions, so two keeper instances can never
// race each other for the same nonce.
const LOCK_CLASS = 0x4f474545;
const LOCK_ID = 1;

export interface KeeperLock {
  /** "held" while this process still holds the lock (re-acquired after a
   * reconnect), "lost" if another session now holds it, "unknown" on DB errors. */
  check(): Promise<"held" | "lost" | "unknown">;
  release(): Promise<void>;
}

/** Waits until the single-keeper lock is acquired on a dedicated connection.
 * Returns undefined if aborted first.
 */
export async function acquireKeeperLock(databaseUrl: string, logger: Logger, signal: AbortSignal,
  retryMs = 15_000): Promise<KeeperLock | undefined> {
  // One long-lived connection: a session-level advisory lock dies with its
  // session, so this connection must not be recycled by idle/lifetime timers.
  const sql = postgres(databaseUrl, { max: 1, idle_timeout: 0, max_lifetime: 0, connect_timeout: 10 });
  const tryLock = async () => {
    const rows = await sql<{ held: boolean }[]>`
      select exists(select 1 from pg_locks where locktype = 'advisory' and pid = pg_backend_pid()
        and classid = ${LOCK_CLASS} and objid = ${LOCK_ID} and objsubid = 2 and granted)
        or pg_try_advisory_lock(${LOCK_CLASS}::int4, ${LOCK_ID}::int4) as held`;
    return rows[0]?.held === true;
  };
  let warned = false;
  while (!signal.aborted) {
    try {
      if (await tryLock()) {
        logger.info("Keeper single-instance lock acquired");
        return {
          check: async () => {
            try { return await tryLock() ? "held" : "lost"; }
            catch (error) {
              logger.warn({ err: safeErrorSummary(error) }, "Keeper lock check failed");
              return "unknown";
            }
          },
          release: async () => { await sql.end({ timeout: 5 }).catch(() => undefined); },
        };
      }
      if (!warned) logger.error("Another keeper instance holds the single-instance lock; waiting to take over");
      warned = true;
    } catch (error) {
      logger.warn({ err: safeErrorSummary(error) }, "Keeper lock acquisition failed; retrying");
    }
    await sleep(retryMs, undefined, { signal }).catch(() => undefined);
  }
  await sql.end({ timeout: 5 }).catch(() => undefined);
  return undefined;
}
