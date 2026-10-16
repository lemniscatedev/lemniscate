import { describe, expect, test } from "bun:test";
import { TtlCache } from "../../api/cache";
import type { ApiDependencies } from "../../api/types";
import { parseStoredSessions } from "../../keeper/sessions";
import { marketSession, sessionFromMeta } from "./sessions";

const pair = (open: string, close: string) => ({ open: String(Date.parse(open) / 1000), close: String(Date.parse(close) / 1000) });
const meta = { sessions: [pair("2026-10-05T00:00:00Z", "2026-10-10T00:00:00Z"), pair("2026-10-12T00:00:00Z", "2026-10-17T00:00:00Z")] };
const at = (value: unknown, time: string) => sessionFromMeta(value, new Date(time));

describe("market session calendar", () => {
  test("uses the pushed session while open and includes the next opening", () => {
    expect(at(meta, "2026-10-06T12:00:00Z")).toEqual({ open: true, opensAt: "2026-10-12T00:00:00.000Z", closesAt: "2026-10-10T00:00:00.000Z", source: "keeper" });
    expect(at(meta, "2026-10-05T00:00:00Z").open).toBe(true);
  });
  test("Friday close is exclusive and Sunday opening is inclusive", () => {
    expect(at(meta, "2026-10-10T00:00:00Z")).toEqual({ open: false, opensAt: "2026-10-12T00:00:00.000Z", closesAt: null, source: "keeper" });
    expect(at(meta, "2026-10-12T00:00:00Z")).toEqual({ open: true, opensAt: null, closesAt: "2026-10-17T00:00:00.000Z", source: "keeper" });
  });
  test("honors stored holiday gaps and custom hours", () => {
    const holiday = { sessions: [pair("2026-11-23T01:00:00Z", "2026-11-26T01:00:00Z"), pair("2026-11-27T01:00:00Z", "2026-11-28T01:00:00Z")] };
    expect(at(holiday, "2026-11-26T12:00:00Z")).toEqual({ open: false, opensAt: "2026-11-27T01:00:00.000Z", closesAt: null, source: "keeper" });
    const custom = { sessions: [pair("2026-10-07T12:00:00Z", "2026-10-07T13:00:00Z")] };
    expect(at(custom, "2026-10-06T12:00:00Z").open).toBe(false);
  });
  test("expired calendar falls back at its exact last close", () => {
    expect(at(meta, "2026-10-17T00:00:00Z")).toEqual({ open: false, opensAt: "2026-10-19T00:00:00.000Z", closesAt: null, source: "computed" });
  });
  test("missing, empty and malformed calendars fall back safely", () => {
    const bad = [undefined, null, {}, { sessions: [] }, { sessions: [{ open: "no", close: "1" }] }, { sessions: [{ open: 1, close: 2 }] }, { sessions: [{ open: "2", close: "1" }] }, { sessions: [null] }, { sessions: [meta.sessions[1], meta.sessions[0]] }, { sessions: [{ open: "1", close: "999999999999999999999" }] }];
    for (const value of bad) expect(at(value, "2026-10-06T12:00:00Z")).toEqual({ open: true, opensAt: "2026-10-12T00:00:00.000Z", closesAt: "2026-10-10T00:00:00.000Z", source: "computed" });
  });
  test("computed holiday gap and DST Sunday boundaries use New York time", () => {
    expect(at({}, "2026-11-26T12:00:00Z").opensAt).toBe("2026-11-27T01:00:00.000Z");
    expect(at({}, "2026-03-07T12:00:00Z").opensAt).toBe("2026-03-09T00:00:00.000Z");
    expect(at({}, "2026-10-31T12:00:00Z").opensAt).toBe("2026-11-02T01:00:00.000Z");
  });
  test("shared parser preserves the keeper's ordered interval validation", () => {
    expect(parseStoredSessions(meta.sessions)).toHaveLength(2);
    expect(parseStoredSessions([{ open: "1", close: "3" }, { open: "2", close: "4" }])).toBeUndefined();
    expect(parseStoredSessions([{ open: "1", close: "3" }, { open: "3", close: "4" }])).toHaveLength(2);
  });
  test("concurrent queries share the cached Postgres calendar", async () => {
    let reads = 0;
    const deps = { cache: new TtlCache(), sql: async () => { reads++; return [{ meta }]; } } as unknown as ApiDependencies;
    const now = new Date("2026-10-06T12:00:00Z");
    const [a, b] = await Promise.all([marketSession(deps, now), marketSession(deps, now)]);
    expect(reads).toBe(1);
    expect(a).toBe(b);
    expect(a.source).toBe("keeper");
    deps.cache.clear();
    await marketSession(deps, now);
    expect(reads).toBe(2);
  });
});
