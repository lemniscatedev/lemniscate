import { encodeFunctionData, keccak256, stringToHex } from "viem";
import { MarketHoursAbi as marketHoursAbi } from "../../abi/MarketHours";
import { computeSessions, parseStoredSessions, type Session } from "../sessions";
import type { KeeperContext } from "../context";

export function sessionHash(sessions: Session[]): string {
  return keccak256(stringToHex(JSON.stringify(sessions.map((s) => [s.open.toString(), s.close.toString()]))));
}

// Compare trading hours only in the window already covered by BOTH calendars.
// Expired intervals and an extension beyond that window need no transaction.
function sameCoverage(prior: Session[], next: Session[], now: bigint, end: bigint): boolean {
  const clip = (sessions: Session[]) => sessions
    .filter((session) => session.close > now && session.open < end)
    .map((session) => ({ open: session.open < now ? now : session.open, close: session.close > end ? end : session.close }));
  return sessionHash(clip(prior)) === sessionHash(clip(next));
}

export async function updateSessions(context: KeeperContext): Promise<Record<string, unknown>> {
  const meta = await context.metadata();
  const now = context.now(meta);
  const sessions = computeSessions(now);
  const sessionsHash = sessionHash(sessions);
  const rows = await context.sql<{ meta: Record<string, unknown> }[]>`select meta from keeper_status where job = 'sessions'`;
  const prior = rows[0]?.meta ?? {};
  const stored = parseStoredSessions(prior.sessions);
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  const horizon = stored?.at(-1)?.close ?? 0n;
  const nextHorizon = sessions.at(-1)?.close ?? 0n;
  const overlapEnd = horizon < nextHorizon ? horizon : nextHorizon;
  if (stored && horizon - nowSeconds >= 7n * 86400n
    && sameCoverage(stored, sessions, nowSeconds, overlapEnd)) {
    // Preserve the actual pushed calendar/hash/horizon for boundary timers.
    return { calendarUpdateNeeded: false };
  }
  const result = await context.tx.submit({
    label: "sessions", to: context.deployment.contracts.marketHours,
    data: encodeFunctionData({ abi: marketHoursAbi, functionName: "setSessions", args: [sessions] }),
  });
  if (result.simulated) return { dryRun: true, proposedSessionsHash: sessionsHash, calendarUpdateNeeded: true };
  return {
    sessionsHash, horizon: sessions.at(-1)?.close.toString() ?? "0",
    sessions: sessions.map((session) => ({ open: session.open.toString(), close: session.close.toString() })),
    dryRun: false,
    calendarUpdateNeeded: true,
  };
}
