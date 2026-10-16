import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows, jsonRecord } from "../../api/types";
import { computeSessions, parseStoredSessions } from "../../keeper/sessions";

export interface MarketSession {
  open: boolean;
  opensAt: string | null;
  closesAt: string | null;
}

export function sessionFromMeta(meta: unknown, now: Date): MarketSession & { source: "keeper" | "computed" } {
  const seconds = BigInt(Math.floor(now.getTime() / 1000));
  const stored = parseStoredSessions(jsonRecord(meta).sessions);
  // Contract timestamps can exceed JavaScript's date range; do not expose invalid ISO dates.
  const usable = stored && stored.at(-1)!.close > seconds
    && stored.every(({ open, close }) => close <= 8_640_000_000_000n && open <= 8_640_000_000_000n);
  const sessions = usable ? stored : computeSessions(now);
  const current = sessions.find((session) => session.open <= seconds && seconds < session.close);
  const next = sessions.find((session) => session.open > seconds);
  const iso = (value: bigint | undefined) => value === undefined ? null : new Date(Number(value) * 1000).toISOString();
  return { open: !!current, opensAt: iso(next?.open), closesAt: iso(current?.close), source: usable ? "keeper" : "computed" };
}

export async function marketSession(deps: ApiDependencies, now: Date) {
  return deps.cache.getOrLoad("markets:session", 30_000, async () => {
    const rows = await deps.sql`select meta from keeper_status where job = 'sessions'`;
    return sessionFromMeta(asRows<DbRow>(rows)[0]?.meta, now);
  });
}
