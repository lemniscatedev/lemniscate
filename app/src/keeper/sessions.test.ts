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
