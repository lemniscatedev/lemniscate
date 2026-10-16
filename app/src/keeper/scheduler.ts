import type { Logger } from "pino";
import type { LemniscateDbClient } from "../db/client";
import { safeErrorSummary } from "../log";

export interface KeeperJob {
  name: string;
  everyMs: number;
  jitterMs?: number;
  initialDelayMs?: number;
  run: () => Promise<Record<string, unknown> | void>;
}

/** Delay before retrying a job that failed `failures` times in a row: 15 s, 30 s, 60 s ... doubling to 10 minutes, and
 * never longer than the job's own interval. An RPC outage therefore backs off instead of hammering the endpoint, and
 * recovers within one interval once it is back. */
export function retryDelayMs(failures: number, everyMs: number): number {
  const delay = Math.min(15_000 * 2 ** Math.max(0, Math.min(failures - 1, 6)), 600_000);
  return Math.min(everyMs, delay);
}

/** Event triggers and timer triggers share the same non-overlapping job slot. A job that throws is logged and retried
 * with backoff; it never stops the other jobs (each has its own slot, timer and failure count). */
export function createScheduler(sql: LemniscateDbClient["sql"], logger: Logger) {
  const jobs = new Map<string, {
    definition: KeeperJob;
    timer?: ReturnType<typeof setTimeout>;
    running?: Promise<void>;
    pending: boolean;
    failures: number;
  }>();
  let stopping = false;

  function schedule(name: string, delay: number) {
    const state = jobs.get(name);
    if (!state || stopping) return;
    if (state.timer) clearTimeout(state.timer);
    state.timer = setTimeout(() => { void trigger(name); }, delay);
  }

  async function trigger(name: string): Promise<void> {
    const state = jobs.get(name);
    if (!state || stopping) return;
    if (state.running) { state.pending = true; return state.running; }
    if (state.timer) clearTimeout(state.timer);
    const definition = state.definition;
    const execute = async () => {
      const started = new Date().toISOString();
      let failed = false;
      let retryAfterMs: number | undefined;
      try {
        const defaults = JSON.stringify({ intervalMs: definition.everyMs });
        await sql`insert into keeper_status (job, last_run, meta) values (${name}, ${started}, ${defaults}::jsonb)
          on conflict (job) do update set last_run = excluded.last_run, meta = keeper_status.meta || excluded.meta`;
        const result = (await definition.run()) ?? {};
        if (typeof result.retryAfterMs === "number" && Number.isFinite(result.retryAfterMs) && result.retryAfterMs > 0) {
          retryAfterMs = Math.max(1000, Math.min(definition.everyMs, result.retryAfterMs));
        }
        const meta = JSON.stringify(result);
        await sql`update keeper_status set last_ok = now(), last_error = null,
          meta = meta || ${meta}::jsonb where job = ${name}`;
        state.failures = 0;
      } catch (error) {
        failed = true;
        state.failures++;
        const summary = safeErrorSummary(error);
        logger.error({ job: name, err: summary }, "Keeper job failed; next trigger will retry");
        try {
          await sql`insert into keeper_status (job, last_run, last_error) values (${name}, ${started}, ${summary.message})
            on conflict (job) do update set last_run = excluded.last_run, last_error = excluded.last_error`;
        } catch (statusError) {
          logger.warn({ err: safeErrorSummary(statusError) }, "Could not record keeper job failure");
        }
      } finally {
        delete state.running;
        // An hourly job can start before the first indexer snapshot exists, or
        // encounter a short RPC outage. Retry it soon rather than leaving
        // sessions/corporate-action state stale for the full interval, but back
        // off while it keeps failing.
        const nextInterval = failed ? retryDelayMs(state.failures, definition.everyMs) : retryAfterMs ?? definition.everyMs;
        const delay = state.pending ? 0 : nextInterval + Math.floor(Math.random() * (definition.jitterMs ?? 0));
        state.pending = false;
        schedule(name, delay);
      }
    };
    state.running = execute();
    return state.running;
  }

  return {
    add(job: KeeperJob) {
      if (jobs.has(job.name) || job.everyMs <= 0) throw new Error(`Invalid or duplicate keeper job: ${job.name}`);
      jobs.set(job.name, { definition: job, pending: false, failures: 0 });
      schedule(job.name, job.initialDelayMs ?? 0);
    },
    trigger,
    async stop() {
      stopping = true;
      for (const state of jobs.values()) if (state.timer) clearTimeout(state.timer);
      await Promise.all([...jobs.values()].map((state) => state.running));
    },
  };
}
