import { describe, expect, test } from "bun:test";
import { decodeFunctionData } from "viem";
import { MarketHoursAbi } from "../abi/MarketHours";
import type { IndexerMetadata, KeeperContext } from "./context";
import { readIndexerMetadata } from "./context";
import { accrueStale } from "./jobs/accrue";
import { sessionHash, updateSessions } from "./jobs/sessions";
import { computeSessions } from "./sessions";

const now = new Date("2026-10-02T12:00:00Z");
const timestamp = (date: Date) => BigInt(Math.floor(date.getTime() / 1000));
const token = "0x0000000000000000000000000000000000000001";

function accrualFixture() {
  const market = { token, state: { vaultShort: "0", lastAccrual: String(timestamp(now) - 8n * 3600n) } };
  const meta = {
    marketsById: { "0": structuredClone(market), "1": structuredClone(market) },
    indexerLastOk: new Date().toISOString(), indexerLastError: null, lagBlocks: "20",
    pendingSnapshot: false, registrySyncPending: false,
  } as unknown as IndexerMetadata;
  let sent = 0;
  let reads = 0;
  let chain: unknown[] = [2, { vaultShort: 0n }, { vaultShort: 0n }];
  let rpcFailed = false;
  const context = {
    metadata: async () => meta, now: () => now,
    config: { KEEPER_ACCRUE_MAX_AGE_SECONDS: 3600 },
    deployment: { markets: [{ id: 0, token }, { id: 1, token }], contracts: { engine: token } },
    tx: { submit: async () => { sent++; return { simulated: false }; } },
    clients: { stateClient: { multicall: async () => {
      reads++;
      if (rpcFailed) throw new Error("unavailable");
      return chain;
    } } },
  } as unknown as KeeperContext;
  return { meta, context, sent: () => sent, reads: () => reads,
    setChain: (value: unknown[]) => { chain = value; }, failRpc: () => { rpcFailed = true; } };
}

describe("idle accrual", () => {
  test("accrues active markets once the configured max age passes", async () => {
    const f = accrualFixture();
    const markets = f.meta.marketsById!;
    markets["0"]!.state.vaultShort = "5";
    markets["0"]!.state.lastAccrual = String(timestamp(now) - 3599n);
    markets["1"]!.state.lastAccrual = String(timestamp(now) - 3599n);
    expect(await accrueStale(f.context)).toEqual({ stale: false, idle: false });
    expect(f.sent()).toBe(0);
    markets["1"]!.state.lastAccrual = String(timestamp(now) - 3600n);
    expect((await accrueStale(f.context)).stale).toBe(true);
    expect(f.sent()).toBe(1);
  });

  test("zero supply skips periodic accrual using the indexer, and verifies forced boundary skips on-chain", async () => {
    const f = accrualFixture();
    expect(await accrueStale(f.context)).toEqual({ stale: true, idle: true });
    expect(f.reads()).toBe(0);
    expect(await accrueStale(f.context, true)).toEqual({ stale: true, idle: true });
    expect(f.reads()).toBe(1);
    expect(f.sent()).toBe(0);
  });

  test("boundary verification catches unindexed buys, new markets and failed or incomplete reads", async () => {
    for (const state of [[2, { vaultShort: 0n }, { vaultShort: 1n }], [3, { vaultShort: 0n }, { vaultShort: 0n }], [2], [2, {}, {}]]) {
      const f = accrualFixture(); f.setChain(state);
      expect((await accrueStale(f.context, true)).idle).toBe(false);
      expect(f.sent()).toBe(1);
    }
    const f = accrualFixture(); f.failRpc();
    await accrueStale(f.context, true);
    expect(f.sent()).toBe(1);
  });

  test("any outstanding share resumes accrual; the last sell returns to idle", async () => {
    const f = accrualFixture();
    f.meta.marketsById!["1"]!.state.vaultShort = "1"; // Raw units; dust must not round to zero.
    expect((await accrueStale(f.context)).idle).toBe(false);
    expect(f.sent()).toBe(1);
    for (const market of Object.values(f.meta.marketsById!)) market.state.lastAccrual = String(timestamp(now));
    await accrueStale(f.context); // Active but recent: no periodic write.
    expect(f.sent()).toBe(1);
    await accrueStale(f.context, true); // Active boundary remains mandatory.
    expect(f.sent()).toBe(2);
    f.meta.marketsById!["1"]!.state.vaultShort = "0";
    expect((await accrueStale(f.context, true)).idle).toBe(true);
    expect(f.sent()).toBe(2);
  });

  test("stale, incomplete, failed or pending indexer observations never prove idle", async () => {
    const cases: ((m: IndexerMetadata) => void)[] = [
      m => { m.indexerLastOk = new Date(Date.now() - 180_000).toISOString(); },
      m => { m.indexerLastOk = new Date(Date.now() + 180_000).toISOString(); },
      m => { delete m.indexerLastOk; },
      m => { m.indexerLastError = "RPC unavailable"; },
      m => { m.lagBlocks = "61"; },
      m => { delete m.lagBlocks; },
      m => { m.pendingSnapshot = true; },
      m => { m.registrySyncPending = true; },
      m => { delete m.marketsById!["1"]; },
      m => { m.marketsById!["01"] = structuredClone(m.marketsById!["1"]!); },
      m => { m.marketsById!["1"]!.token = "0x0000000000000000000000000000000000000002"; },
      m => { delete m.marketsById!["1"]!.state.vaultShort; },
      m => { m.marketsById!["1"]!.state.vaultShort = "invalid"; },
      m => { m.marketsById!["1"]!.state.vaultShort = "-1"; },
    ];
    for (const change of cases) {
      const f = accrualFixture(); change(f.meta);
      expect((await accrueStale(f.context)).idle).toBe(false);
      expect(f.sent()).toBe(1);
    }
  });

  test("uses the indexer status timestamp, not an old timestamp embedded in metadata", async () => {
    const sql = (async () => [{ meta: { indexerLastOk: "old", lagBlocks: "20" }, last_ok: now, last_error: null }]) as unknown as KeeperContext["sql"];
    expect(await readIndexerMetadata(sql)).toEqual({ indexerLastOk: now.toISOString(), indexerLastError: null, lagBlocks: "20" });
  });
});

function calendarFixture(pushedAt: Date, checkedAt: Date) {
  const stored = computeSessions(pushedAt);
  const prior: Record<string, unknown> = {
    sessions: stored.map(s => ({ open: String(s.open), close: String(s.close) })),
    sessionsHash: sessionHash(stored), horizon: String(stored.at(-1)!.close),
  };
  const sent: { data: `0x${string}` }[] = [];
  let simulated = false;
  const context = {
    metadata: async () => ({}), now: () => checkedAt, sql: async () => [{ meta: prior }],
    deployment: { contracts: { marketHours: token } },
    tx: { submit: async (tx: { data: `0x${string}` }) => { sent.push(tx); return { simulated }; } },
  } as unknown as KeeperContext;
  return { prior, stored, sent, context, dryRun: () => { simulated = true; } };
}

describe("calendar maintenance", () => {
  test("expired sessions and newly generated extensions do not rewrite covered future hours", async () => {
    const f = calendarFixture(new Date("2026-10-02T12:00:00Z"), new Date("2026-10-04T12:00:00Z"));
    const before = structuredClone(f.prior);
    expect(sessionHash(computeSessions(f.context.now({})))).not.toBe(f.prior.sessionsHash);
    const result = await updateSessions(f.context);
    expect(result).toEqual({ calendarUpdateNeeded: false });
    expect(f.sent).toHaveLength(0);
    expect({ ...f.prior, ...result }).toMatchObject(before); // Preserve the actual on-chain calendar for timers.
  });

  test("coverage under seven days is extended and the submitted calendar is recorded", async () => {
    const f = calendarFixture(new Date("2026-10-02T12:00:00Z"), new Date("2026-10-11T12:00:00Z"));
    const result = await updateSessions(f.context);
    expect(f.sent).toHaveLength(1);
    const decoded = decodeFunctionData({ abi: MarketHoursAbi, data: f.sent[0]!.data });
    expect(decoded.functionName).toBe("setSessions");
    expect(decoded.args![0]).toEqual(computeSessions(f.context.now({})));
    expect(result.horizon).toBe(String(computeSessions(f.context.now({})).at(-1)!.close));
    expect(result.dryRun).toBe(false);
  });

  test("exactly seven days is retained; one second less triggers a refresh", async () => {
    const pushedAt = new Date("2026-10-02T12:00:00Z");
    const horizon = computeSessions(pushedAt).at(-1)!.close;
    const threshold = new Date(Number(horizon - 7n * 86400n) * 1000);
    const atThreshold = calendarFixture(pushedAt, threshold);
    await updateSessions(atThreshold.context);
    expect(atThreshold.sent).toHaveLength(0);
    const below = calendarFixture(pushedAt, new Date(threshold.getTime() + 1000));
    await updateSessions(below.context);
    expect(below.sent).toHaveLength(1);
  });

  test("changed future hours and missing sessions are corrected even with a long horizon", async () => {
    for (const missing of [false, true]) {
      const f = calendarFixture(now, now);
      const stored = f.prior.sessions as { open: string; close: string }[];
      if (missing) stored.splice(1, 1);
      else stored[1]!.open = String(BigInt(stored[1]!.open) + 3600n);
      expect((await updateSessions(f.context)).calendarUpdateNeeded).toBe(true);
      expect(f.sent).toHaveLength(1);
    }
  });

  test("Thanksgiving closure corrections are not suppressed by horizon-only comparison", async () => {
    const day = new Date("2026-11-23T12:00:00Z");
    const f = calendarFixture(day, day);
    const sessions = f.prior.sessions as { open: string; close: string }[];
    sessions[0]!.close = sessions[1]!.close; // Incorrectly trade through the holiday.
    sessions.splice(1, 1);
    await updateSessions(f.context);
    expect(f.sent).toHaveLength(1);
  });

  test("a historical opening change does not rewrite an unchanged active interval", async () => {
    const f = calendarFixture(now, now);
    (f.prior.sessions as { open: string; close: string }[])[0]!.open = String(f.stored[0]!.open - 60n);
    await updateSessions(f.context);
    expect(f.sent).toHaveLength(0);
  });

  test("missing/malformed calendars are repaired, but simulation never advances the recorded horizon", async () => {
    for (const invalid of [undefined, [], [{ open: "bad", close: "0" }]]) {
      const f = calendarFixture(now, now); f.prior.sessions = invalid;
      f.dryRun();
      const result = await updateSessions(f.context);
      expect(f.sent).toHaveLength(1);
      expect(result.dryRun).toBe(true);
      expect(result.sessions).toBeUndefined();
      expect(result.horizon).toBeUndefined();
    }
  });
});
