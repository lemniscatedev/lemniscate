import { CALENDAR_YEARS, EARLY_CLOSE_DATES, FULL_DAY_CLOSURES } from "./holidays";

export interface Session {
  open: bigint;
  close: bigint;
}

export function parseStoredSessions(value: unknown): Session[] | undefined {
  if (!Array.isArray(value) || !value.length) return undefined;
  const sessions: Session[] = [];
  for (const item of value) {
    if (!item || typeof item.open !== "string" || typeof item.close !== "string"
      || !/^\d+$/.test(item.open) || !/^\d+$/.test(item.close)) return undefined;
    const session = { open: BigInt(item.open), close: BigInt(item.close) };
    if (session.close <= session.open || (sessions.length && session.open < sessions.at(-1)!.close)) return undefined;
    sessions.push(session);
  }
  return sessions;
}

const DAY = 86_400_000;
const ny = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York",
  year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
});

function localParts(time: number): Record<string, number> {
  return Object.fromEntries(ny.formatToParts(time)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, Number(part.value)]));
}

function dateKey(calendarDay: number): string {
  return new Date(calendarDay).toISOString().slice(0, 10);
}

// calendarDay encodes a local calendar date at UTC midnight, not a NY instant.
// Convert each boundary separately, so DST changes never assume a fixed offset.
function boundary(calendarDay: number): bigint {
  const target = calendarDay + 20 * 3_600_000;
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = localParts(instant);
    const represented = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
    const adjustment = target - represented;
    instant += adjustment;
    if (!adjustment) return BigInt(instant / 1000);
  }
  throw new Error("Could not resolve New York session boundary");
}

/** A stable weekly calendar covering at least `days` ahead (up to the final Friday).
 * Keeps full current sessions; the result changes only at session/week boundaries.
 * Full-day holidays remove the preceding 20:00 ET through holiday 20:00 ET.
 */
export function computeSessions(now = new Date(), days = 14): Session[] {
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(days) || days < 1 || days > 21) {
    throw new Error("Session horizon must be 1–21 days and now must be a valid date");
  }
  const p = localParts(now.getTime());
  const today = Date.UTC(p.year!, p.month! - 1, p.day!);
  const sunday = today - new Date(today).getUTCDay() * DAY;
  const horizon = today + days * DAY;
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  const result: Session[] = [];

  for (let week = sunday; week <= horizon; week += 7 * DAY) {
    let intervals: Session[] = [{ open: boundary(week), close: boundary(week + 5 * DAY) }];
    for (let day = 1; day <= 5; day++) {
      const holiday = week + day * DAY;
      if (!CALENDAR_YEARS.has(new Date(holiday).getUTCFullYear())) {
        throw new Error("Session holiday calendar needs updating beyond 2026–2028");
      }
      if (!FULL_DAY_CLOSURES.has(dateKey(holiday))) continue;
      const closedFrom = boundary(holiday - DAY);
      const closedTo = boundary(holiday);
      intervals = intervals.flatMap((session) => {
        if (closedTo <= session.open || closedFrom >= session.close) return [session];
        const pieces: Session[] = [];
        if (session.open < closedFrom) pieces.push({ open: session.open, close: closedFrom });
        if (closedTo < session.close) pieces.push({ open: closedTo, close: session.close });
        return pieces;
      });
    }
    result.push(...intervals.filter((session) => session.close > nowSeconds));
  }
  if (result.length > 32) throw new Error("Session calendar exceeds the contract limit");
  return result;
}

// ---------------------------------------------------------------------------------------------------------------
// Sessions with a kind (MarketHours.setSessionsWithKinds)
// ---------------------------------------------------------------------------------------------------------------

/** Mirrors the SessionKind values the contract accepts in a pushed calendar (REGULAR = 0, EXTENDED = 1). */
export const SESSION_REGULAR = 0;
export const SESSION_EXTENDED = 1;

export interface KindedSession extends Session {
  kind: typeof SESSION_REGULAR | typeof SESSION_EXTENDED;
}

/** MarketHours limits (contract constants): at most 32 sessions, none longer than 5 days 1 hour, last close within 30 days. */
export const MAX_SESSIONS = 32;
export const MAX_SESSION_SECONDS = 5n * 86_400n + 3_600n;
export const MAX_HORIZON_SECONDS = 30n * 86_400n;

const REGULAR_OPEN_MINUTE = 9 * 60 + 30;
const REGULAR_CLOSE_MINUTE = 16 * 60;
const EARLY_CLOSE_MINUTE = 13 * 60;
const EXTENDED_END_MINUTE = 20 * 60;
const OVERNIGHT_END_MINUTE = 4 * 60;

/** Instant of `minute` (minutes after midnight, New York time) on the local calendar date encoded by `calendarDay`. */
function etInstant(calendarDay: number, minute: number): bigint {
  const target = calendarDay + minute * 60_000;
  let instant = target;
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = localParts(instant);
    const represented = Date.UTC(p.year!, p.month! - 1, p.day!, p.hour!, p.minute!, p.second!);
    const adjustment = target - represented;
    instant += adjustment;
    if (!adjustment) return BigInt(instant / 1000);
  }
  throw new Error("Could not resolve New York session boundary");
}

function isTradingDay(calendarDay: number): boolean {
  const weekday = new Date(calendarDay).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  if (!CALENDAR_YEARS.has(new Date(calendarDay).getUTCFullYear())) {
    throw new Error("Session holiday calendar needs updating beyond 2026–2028");
  }
  return !FULL_DAY_CLOSURES.has(dateKey(calendarDay));
}

/** The pushed calendar, one entry per REGULAR or EXTENDED stretch, the way `NyseCalendar.kindAt` classifies time:
 *   overnight 20:00 (previous evening) to 04:00, pre-market 04:00 to 09:30 -> EXTENDED
 *   regular 09:30 to 16:00 (13:00 on an early close)                      -> REGULAR
 *   post-market until 20:00                                              -> EXTENDED
 * The evening before a full holiday and the holiday itself are gaps (CLOSED). Neighbouring stretches of the same
 * kind are merged, so a normal trading day is one EXTENDED and one REGULAR session.
 * The list starts with the stretch that contains `now` and ends at the 32-session / 30-day limit of the contract:
 * past the last close the contract falls back to its own calendar (or UNKNOWN), never to a false CLOSED. */
export function computeKindedSessions(now = new Date(), days = 30): KindedSession[] {
  if (!Number.isFinite(now.getTime()) || !Number.isInteger(days) || days < 1 || days > 30) {
    throw new Error("Session horizon must be 1–30 days and now must be a valid date");
  }
  const p = localParts(now.getTime());
  const today = Date.UTC(p.year!, p.month! - 1, p.day!);
  const nowSeconds = BigInt(Math.floor(now.getTime() / 1000));
  const limit = nowSeconds + BigInt(days) * 86_400n;
  const pieces: KindedSession[] = [];
  const push = (open: bigint, close: bigint, kind: KindedSession["kind"]) => {
    const last = pieces.at(-1);
    if (last && last.kind === kind && last.close === open) last.close = close;
    else pieces.push({ open, close, kind });
  };

  for (let day = today - DAY; day <= today + days * DAY + DAY; day += DAY) {
    if (!isTradingDay(day)) continue;
    const key = dateKey(day);
    const regularClose = EARLY_CLOSE_DATES.has(key) ? EARLY_CLOSE_MINUTE : REGULAR_CLOSE_MINUTE;
    push(etInstant(day - DAY, EXTENDED_END_MINUTE), etInstant(day, OVERNIGHT_END_MINUTE), SESSION_EXTENDED);
    push(etInstant(day, OVERNIGHT_END_MINUTE), etInstant(day, REGULAR_OPEN_MINUTE), SESSION_EXTENDED);
    push(etInstant(day, REGULAR_OPEN_MINUTE), etInstant(day, regularClose), SESSION_REGULAR);
    push(etInstant(day, regularClose), etInstant(day, EXTENDED_END_MINUTE), SESSION_EXTENDED);
  }

  const result = pieces.filter((session) => session.close > nowSeconds && session.close <= limit).slice(0, MAX_SESSIONS);
  for (const session of result) if (session.close - session.open > MAX_SESSION_SECONDS) throw new Error("Session longer than the contract allows");
  return result;
}

/** Neighbouring sessions that touch merge into one window: the 24/5 "market is open" windows the API shows. */
export function mergeWindows(sessions: readonly Session[]): Session[] {
  const windows: Session[] = [];
  for (const session of sessions) {
    const last = windows.at(-1);
    if (last && last.close === session.open) last.close = session.close;
    else windows.push({ open: session.open, close: session.close });
  }
  return windows;
}

/** Parses `{ open, close, kind }` strings from keeper_status.meta.kinded; undefined when anything is malformed. */
export function parseStoredKinded(value: unknown): KindedSession[] | undefined {
  const base = parseStoredSessions(value);
  if (!base || !Array.isArray(value)) return undefined;
  const kinded: KindedSession[] = [];
  for (let i = 0; i < base.length; i++) {
    const kind = (value[i] as { kind?: unknown }).kind;
    if (kind !== SESSION_REGULAR && kind !== SESSION_EXTENDED) return undefined;
    kinded.push({ ...base[i]!, kind });
  }
  return kinded;
}
