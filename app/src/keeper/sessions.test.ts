import { describe, expect, test } from "bun:test";
import { computeSessions, type Session } from "./sessions";

const timestamp = (iso: string) => BigInt(Date.parse(iso) / 1000);
const openAt = (sessions: Session[], iso: string) => {
  const time = timestamp(iso);
  return sessions.some((session) => session.open <= time && time < session.close);
};

describe("24/5 New York calendar", () => {
  test("spring DST changes the UTC Sunday opening", () => {
    const sessions = computeSessions(new Date("2026-03-01T12:00:00Z"));
    expect(sessions[0]!.open).toBe(timestamp("2026-03-02T01:00:00Z"));
    expect(sessions[1]!.open).toBe(timestamp("2026-03-09T00:00:00Z"));
    expect(openAt(sessions, "2026-03-07T00:59:59Z")).toBe(true);
    expect(openAt(sessions, "2026-03-07T01:00:00Z")).toBe(false);
    expect(openAt(sessions, "2026-03-08T23:59:59Z")).toBe(false);
    expect(openAt(sessions, "2026-03-09T00:00:00Z")).toBe(true);
  });

  test("autumn DST changes the UTC Sunday opening", () => {
    const sessions = computeSessions(new Date("2026-10-25T12:00:00Z"));
    expect(sessions[0]!.open).toBe(timestamp("2026-10-26T00:00:00Z"));
    expect(sessions[1]!.open).toBe(timestamp("2026-11-02T01:00:00Z"));
  });

  test("Thanksgiving removes Wednesday evening through Thursday evening", () => {
    const sessions = computeSessions(new Date("2026-11-23T12:00:00Z"));
    expect(openAt(sessions, "2026-11-26T00:59:59Z")).toBe(true);
    expect(openAt(sessions, "2026-11-26T01:00:00Z")).toBe(false);
    expect(openAt(sessions, "2026-11-27T00:59:59Z")).toBe(false);
    expect(openAt(sessions, "2026-11-27T01:00:00Z")).toBe(true);
    // An early NYSE close does not shorten LEMNISCATE's stock-token calendar.
    expect(openAt(sessions, "2026-11-27T22:00:00Z")).toBe(true);
    expect(openAt(sessions, "2026-11-28T01:00:00Z")).toBe(false);
  });

  test("Monday holiday delays the opening until Monday evening", () => {
    const sessions = computeSessions(new Date("2026-01-18T12:00:00Z"));
    expect(sessions[0]!.open).toBe(timestamp("2026-01-20T01:00:00Z"));
  });

  test("Saturday New Year 2028 does not close December 31, 2027", () => {
    const sessions = computeSessions(new Date("2027-12-30T12:00:00Z"));
    expect(openAt(sessions, "2027-12-31T16:00:00Z")).toBe(true);
  });

  test("hourly recomputation stays stable and respects contract bounds", () => {
    const first = computeSessions(new Date("2026-09-30T08:00:00Z"));
    expect(computeSessions(new Date("2026-09-30T09:00:00Z"))).toEqual(first);
    expect(first.length).toBeLessThanOrEqual(32);
    first.forEach((session, i) => {
      expect(session.close > session.open).toBe(true);
      expect(session.close - session.open <= 5n * 86400n + 3600n).toBe(true);
      if (i) expect(session.open >= first[i - 1]!.close).toBe(true);
    });
    expect(first.at(-1)!.close > timestamp("2026-10-14T08:00:00Z")).toBe(true);
  });

  test("unknown holiday years fail closed", () => {
    expect(() => computeSessions(new Date("2029-02-01T00:00:00Z"))).toThrow("calendar needs updating");
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Sessions with a kind
// ---------------------------------------------------------------------------------------------------------------
import { computeKindedSessions, mergeWindows, SESSION_EXTENDED, SESSION_REGULAR } from "./sessions";
import { FULL_DAY_CLOSURES, EARLY_CLOSE_DATES } from "./holidays";

const nyParts = new Intl.DateTimeFormat("en-CA", {
  timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit",
  hour: "2-digit", minute: "2-digit", hourCycle: "h23",
});

/** An independent TypeScript port of NyseCalendar.kindAt (contracts/src/libs/NyseCalendar.sol): 0 REGULAR, 1 EXTENDED, 2 CLOSED. */
function referenceKind(seconds: bigint): number {
  const parts = Object.fromEntries(nyParts.formatToParts(Number(seconds) * 1000).filter((p) => p.type !== "literal").map((p) => [p.type, Number(p.value)]));
  const day = Date.UTC(parts.year!, parts.month! - 1, parts.day!);
  const minute = parts.hour! * 60 + parts.minute!;
  const key = (d: number) => new Date(d).toISOString().slice(0, 10);
  const closeOf = (d: number): number => {
    const weekday = new Date(d).getUTCDay();
    if (weekday === 0 || weekday === 6 || FULL_DAY_CLOSURES.has(key(d))) return 0;
    return EARLY_CLOSE_DATES.has(key(d)) ? 13 * 60 : 16 * 60;
  };
  if (minute >= 20 * 60) return closeOf(day + 86_400_000) === 0 ? 2 : 1;
  const close = closeOf(day);
  if (close === 0) return 2;
  if (minute < 9 * 60 + 30) return 1;
  if (minute < close) return 0;
  return 1;
}

function pushedKind(sessions: { open: bigint; close: bigint; kind: number }[], t: bigint): number {
  // Same rule as MarketHours.kindAt inside the covered range.
  const hit = sessions.find((s) => s.open <= t && t < s.close);
  return hit ? hit.kind : 2;
}

describe("kinded sessions", () => {
  const starts = [
    "2026-03-04T12:00:00Z", // before the March DST change
    "2026-10-30T12:00:00Z", // across the November DST change
    "2026-11-24T12:00:00Z", // Thanksgiving week, early close on the Friday
    "2026-12-21T12:00:00Z", // Christmas Eve early close, Christmas holiday
    "2027-01-14T12:00:00Z", // MLK Monday
  ];

  for (const start of starts) {
    test(`agrees with the on-chain NYSE calendar every 10 minutes from ${start}`, () => {
      const now = new Date(start);
      const sessions = computeKindedSessions(now);
      const first = sessions[0]!.open;
      const last = sessions.at(-1)!.close;
      let checked = 0;
      for (let t = first < BigInt(now.getTime() / 1000) ? BigInt(now.getTime() / 1000) : first; t < last; t += 600n) {
        expect(pushedKind(sessions, t)).toBe(referenceKind(t));
        checked++;
      }
      expect(checked).toBeGreaterThan(500);
    });
  }

  test("early close ends the regular session at 13:00 New York time", () => {
    const sessions = computeKindedSessions(new Date("2026-11-24T12:00:00Z"));
    const regular = sessions.find((s) => s.kind === SESSION_REGULAR && s.open === timestamp("2026-11-27T14:30:00Z"));
    expect(regular?.close).toBe(timestamp("2026-11-27T18:00:00Z"));
    const christmasEve = computeKindedSessions(new Date("2026-12-21T12:00:00Z"))
      .find((s) => s.kind === SESSION_REGULAR && s.open === timestamp("2026-12-24T14:30:00Z"));
    expect(christmasEve?.close).toBe(timestamp("2026-12-24T18:00:00Z"));
  });

  test("a normal day is one extended and one regular session; boundaries follow DST", () => {
    const sessions = computeKindedSessions(new Date("2026-03-01T12:00:00Z"));
    // Monday 2 March 2026 (EST): extended from Sunday 20:00 ET = 01:00Z until 09:30 ET = 14:30Z, regular until 21:00Z.
    expect(sessions[0]).toEqual({ open: timestamp("2026-03-02T01:00:00Z"), close: timestamp("2026-03-02T14:30:00Z"), kind: SESSION_EXTENDED });
    expect(sessions[1]).toEqual({ open: timestamp("2026-03-02T14:30:00Z"), close: timestamp("2026-03-02T21:00:00Z"), kind: SESSION_REGULAR });
    expect(sessions[2]!.open).toBe(timestamp("2026-03-02T21:00:00Z"));
    expect(sessions[2]!.kind).toBe(SESSION_EXTENDED);
  });

  test("the list respects the contract limits and starts with the current session", () => {
    const now = new Date("2026-09-30T08:00:00Z");
    const sessions = computeKindedSessions(now);
    expect(sessions.length).toBeLessThanOrEqual(32);
    expect(sessions.length).toBeGreaterThan(20);
    const nowSeconds = BigInt(now.getTime() / 1000);
    expect(sessions[0]!.close > nowSeconds).toBe(true);
    expect(sessions.at(-1)!.close <= nowSeconds + 30n * 86400n).toBe(true);
    sessions.forEach((s, i) => {
      expect(s.close - s.open <= 5n * 86400n + 3600n).toBe(true);
      if (i) expect(s.open >= sessions[i - 1]!.close).toBe(true);
    });
  });

  test("merged windows equal the 24/5 windows of the plain calendar over the same span", () => {
    const now = new Date("2026-11-23T12:00:00Z");
    const windows = mergeWindows(computeKindedSessions(now));
    const plain = computeSessions(now);
    for (const w of windows.slice(0, 3)) {
      expect(plain.some((p) => p.open === w.open || p.open < w.open)).toBe(true);
    }
    // Thanksgiving gap: no window covers Thursday afternoon.
    expect(windows.some((w) => w.open <= timestamp("2026-11-26T18:00:00Z") && timestamp("2026-11-26T18:00:00Z") < w.close)).toBe(false);
  });
});
