import { encodeFunctionData, keccak256, stringToHex } from "viem";
import { MarketHoursAbi as marketHoursAbi } from "../../abi/MarketHours";
import {
  computeKindedSessions, mergeWindows, parseStoredKinded, type KindedSession, type Session,
} from "../sessions";
import type { KeeperContext } from "../context";
import { keepLastGoodPrices } from "./prices";

export function sessionHash(sessions: readonly (Session & { kind?: number })[]): string {
  return keccak256(stringToHex(JSON.stringify(sessions.map((s) =>
    s.kind === undefined ? [s.open.toString(), s.close.toString()] : [s.open.toString(), s.close.toString(), s.kind]))));
}

/** What keeper_status.meta stores about the pushed calendar: `sessions` are the merged 24/5 windows (what the API
 * and the boundary timers read), `kinded` is exactly what the contract holds. */
export function sessionsMeta(sessions: readonly KindedSession[]): Record<string, unknown> {
  const windows = mergeWindows(sessions);
  return {
    sessionsHash: sessionHash(sessions),
    horizon: sessions.at(-1)?.close.toString() ?? "0",
    sessions: windows.map((s) => ({ open: s.open.toString(), close: s.close.toString() })),
    kinded: sessions.map((s) => ({ open: s.open.toString(), close: s.close.toString(), kind: s.kind })),
  };
}

// Compare trading hours only in the window already covered by BOTH calendars.
// Expired intervals and an extension beyond that window need no transaction.
function sameCoverage(prior: KindedSession[], next: KindedSession[], now: bigint, end: bigint): boolean {
  const clip = (sessions: KindedSession[]) => sessions
    .filter((session) => session.close > now && session.open < end)
    .map((session) => ({
      open: session.open < now ? now : session.open, close: session.close > end ? end : session.close, kind: session.kind,
    }));
  return sessionHash(clip(prior)) === sessionHash(clip(next));
}

/** R3: keeps MarketHours' calendar at least `REFRESH_BEFORE_DAYS` ahead. A push replaces the whole list, so it is only
 * sent when the contract's horizon is closing in or the part both calendars cover differs (a corrected holiday). */
const REFRESH_BEFORE_DAYS = 7n;
/** R3-03 follow-up: a push deferred for a failed halt-latch upkeep is sent anyway once the pushed calendar ends this soon. */
const PUSH_ANYWAY_HOURS = 24n;

export async function updateSessions(context: KeeperContext): Promise<Record<string, unknown>> {
  const marketHours = context.deployment.contracts.marketHours;
  if (!marketHours) throw new Error("Deployment has no marketHours address; the sessions job cannot run");
  const meta = await context.metadata();
  const now = context.now(meta);
  const sessions = computeKindedSessions(now);
  const rows = await context.sql<{ meta: Record<string, unknown> }[]>`select meta from keeper_status where job = 'sessions'`;
  const prior = rows[0]?.meta ?? {};
  const stored = parseStoredKinded(prior.kinded);
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  const horizon = stored?.at(-1)?.close ?? 0n;
  const nextHorizon = sessions.at(-1)?.close ?? 0n;
  const overlapEnd = horizon < nextHorizon ? horizon : nextHorizon;
  if (stored && horizon - nowSeconds >= REFRESH_BEFORE_DAYS * 86400n
    && sameCoverage(stored, sessions, nowSeconds, overlapEnd)) {
    // Preserve the actual pushed calendar/hash/horizon for boundary timers.
    return { calendarUpdateNeeded: false };
  }
  // Review R3-03: the push deletes every past session, which is what PriceGuard derives a halt start from. Store any
  // visible derived start first (the price upkeep pokes such a stock in any session), so the halt start never moves later.
  // If that upkeep could not read a stock or a poke failed, skip this push and retry next hour, unless the pushed calendar
  // ends within PUSH_ANYWAY_HOURS (an expired calendar reads UNKNOWN for every stock, which is worse).
  if (context.deployment.contracts.priceGuard && context.deployment.stocks.length > 0) {
    const upkeep = await keepLastGoodPrices(context);
    if ((upkeep.failed.length > 0 || upkeep.unread.length > 0) && horizon - nowSeconds > PUSH_ANYWAY_HOURS * 3600n) {
      context.logger.warn({ failed: upkeep.failed, unread: upkeep.unread }, "Calendar push deferred: the halt-latch upkeep did not complete");
      return { calendarUpdateNeeded: true, deferred: true, failed: upkeep.failed, unread: upkeep.unread };
    }
  }
  const result = await context.tx.submit({
    label: "sessions", to: marketHours,
    data: encodeFunctionData({
      abi: marketHoursAbi, functionName: "setSessionsWithKinds",
      args: [sessions.map((s) => ({ open: s.open, close: s.close })), sessions.map((s) => s.kind)],
    }),
  });
  if (result.simulated) {
    return { dryRun: true, proposedSessionsHash: sessionHash(sessions), calendarUpdateNeeded: true };
  }
  return { ...sessionsMeta(sessions), dryRun: false, calendarUpdateNeeded: true };
}
