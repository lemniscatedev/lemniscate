import { CALENDAR_YEARS, FULL_DAY_CLOSURES } from "./holidays";

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
