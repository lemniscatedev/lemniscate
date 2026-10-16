import type { ApiDependencies, DbRow } from "./types";
import { asRows, jsonRecord, dateValue } from "./types";

interface ClockAnchor {
  chainTimestampSeconds: number;
  observedAtMs: number;
}

/**
 * Market data on a local fork uses chain timestamps, which may be far behind
 * wall time. Advance the most recently observed chain timestamp by wall time
 * elapsed since the indexer observed it. Non-fork networks and fixture data
 * without a valid anchor use wall time.
 */
export async function apiNow(deps: ApiDependencies, wallNow = new Date()): Promise<Date> {
  if (deps.config.NETWORK !== "fork") return wallNow;

  const anchor = await deps.cache.getOrLoad<ClockAnchor | null>("api:fork-clock-anchor", 1_000, async () => {
    const result = await deps.sql`select meta from keeper_status where job = 'indexer' limit 1`;
    const row = asRows<DbRow>(result)[0];
    const meta = jsonRecord(row?.meta);
    const secondsValue = meta.chainTimestamp;
    const secondsText = typeof secondsValue === "string" ? secondsValue : String(secondsValue ?? "");
    const seconds = /^\d+$/.test(secondsText) ? Number(secondsText) : Number.NaN;
    const observedAt = dateValue(meta.chainTimeObservedAt);
    if (!Number.isSafeInteger(seconds) || seconds < 0 || !observedAt) return null;
    return { chainTimestampSeconds: seconds, observedAtMs: observedAt.getTime() };
  });

  if (!anchor) return wallNow;
  const elapsedMs = Math.max(0, wallNow.getTime() - anchor.observedAtMs);
  return new Date(anchor.chainTimestampSeconds * 1_000 + elapsedMs);
}
