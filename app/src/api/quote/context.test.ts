import { describe, expect, test } from "bun:test";
import { sessionNow } from "./context";
import type { TickRow } from "../../db/queries/market";

// New York is UTC-4 in October 2026 (DST ends Nov 1).
const ny = (iso: string) => new Date(`${iso}-04:00`).getTime();
const tick = (session: TickRow["session"], iso: string): TickRow =>
  ({ name: "NVDA", stock: "0x01", ts: new Date(ny(iso)).toISOString(), spot: "214", session, fresh: true, buysPaused: false, priceUpdatedAt: null } as unknown as TickRow);

describe("session at the API clock (todo 23 fork bug: a weekend sell was quoted at the regular spread)", () => {
  test("a session boundary crossed since the last indexed tick moves the session with the calendar", () => {
    expect(sessionNow(tick("EXTENDED", "2026-10-16T19:58:00"), ny("2026-10-16T20:03:00"))).toBe("CLOSED"); // Friday close
    expect(sessionNow(tick("REGULAR", "2026-10-19T10:00:00"), ny("2026-10-24T12:00:00"))).toBe("CLOSED"); // to Saturday
    expect(sessionNow(tick("CLOSED", "2026-10-17T12:00:00"), ny("2026-10-19T10:05:00"))).toBe("REGULAR"); // Monday open
    expect(sessionNow(tick("REGULAR", "2026-10-19T15:58:00"), ny("2026-10-19T16:02:00"))).toBe("EXTENDED"); // after the bell
  });
  test("inside the same window the indexed reading stands, and a halted feed stays halted across a live boundary", () => {
    expect(sessionNow(tick("REGULAR", "2026-10-19T10:00:00"), ny("2026-10-19T10:05:00"))).toBe("REGULAR");
    expect(sessionNow(tick("HALTED", "2026-10-19T10:00:00"), ny("2026-10-19T10:05:00"))).toBe("HALTED");
    expect(sessionNow(tick("HALTED", "2026-10-19T15:58:00"), ny("2026-10-19T16:02:00"))).toBe("HALTED");
  });
});
