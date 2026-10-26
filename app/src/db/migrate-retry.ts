/**
 * Lock-safe migrations for deploys under live load (release runner review, SHOULD-FIX 13).
 *
 * Every migration session gets lock_timeout, so an ALTER that waits behind live API queries gives up after a few seconds
 * instead of queueing every API query behind its lock for minutes. A lock timeout is retried with a short pause; if it
 * keeps happening the process exits 75 ("nothing changed": the migrator runs in one transaction, which is rolled back),
 * and deploy.sh points /opt/lemniscate/current back and reports "nothing switched" so the runner simply tries later.
 */

/** Postgres SQLSTATE 55P03 lock_not_available (what lock_timeout raises). */
export const LOCK_NOT_AVAILABLE = "55P03";
/** Exit code for "nothing changed, try again later" (same as deploy.sh's). */
export const EXIT_NOT_SWITCHED = 75;

export function isLockTimeout(error: unknown): boolean {
  for (let e: unknown = error, depth = 0; e && typeof e === "object" && depth < 5; depth += 1) {
    const r = e as Record<string, unknown>;
    if (r.code === LOCK_NOT_AVAILABLE) return true;
    if (typeof r.message === "string" && /lock timeout/i.test(r.message)) return true;
    e = r.cause;
  }
  return false;
}

export interface RetryResult {
  readonly ok: boolean;
  readonly attempts: number;
  readonly lockTimeout: boolean;
  readonly error?: unknown;
}

/** Runs `run` up to `tries` times while it fails with a lock timeout, waiting `waitMs` between tries. */
export async function migrateWithLockRetry(
  run: () => Promise<void>,
  tries = 3,
  waitMs = 5000,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
): Promise<RetryResult> {
  let last: unknown;
  for (let attempt = 1; attempt <= tries; attempt += 1) {
    try {
      await run();
      return { ok: true, attempts: attempt, lockTimeout: false };
    } catch (error) {
      last = error;
      if (!isLockTimeout(error)) return { ok: false, attempts: attempt, lockTimeout: false, error };
      if (attempt < tries) await sleep(waitMs);
    }
  }
  return { ok: false, attempts: tries, lockTimeout: true, error: last };
}
