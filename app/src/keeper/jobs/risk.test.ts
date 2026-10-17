import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { decodeFunctionData } from "viem";
import { OptionEngineAbi } from "../../abi";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../../testing/db";
import { A, FakeChain } from "../test-support";
import { createRiskJob, evaluateRisk, type RiskInputs } from "./risk";

const NOW = new Date("2026-10-16T15:00:00Z");
const min = (m: number) => new Date(NOW.getTime() - m * 60_000);

function inputs(patch: Partial<RiskInputs> = {}): RiskInputs {
  return {
    now: NOW,
    indexer: { indexerLastOk: min(1).toISOString(), indexerLastError: null, lastSnapshotAt: min(2).toISOString(), lagBlocks: "2" },
    pool: { current: 1, peak: 1, latestAt: min(2) },
    names: [
      { name: "NVDA", stockToken: A.nvda, netDelta: 1, netGamma: 0.1, netVega: 2, stressLossBps: 100, limitsAt: min(2), session: "REGULAR", fresh: true, volStale: false, volStaleSince: null },
      { name: "SPY", stockToken: A.spy, netDelta: -1, netGamma: 0.1, netVega: 2, stressLossBps: 50, limitsAt: min(2), session: "REGULAR", fresh: true, volStale: false, volStaleSince: null },
    ],
    hedgeEquity: null, hedger: null,
    ...patch,
  };
}

describe("evaluateRisk", () => {
  test("on a fork moved ahead in time, a live indexer is still trusted (its stamps are wall time; todo 23)", () => {
    const chainAhead = new Date(NOW.getTime() + 3 * 86_400_000);
    const names = inputs().names.map((n) => ({ ...n, limitsAt: new Date(chainAhead.getTime() - 120_000) })); // block time
    const e = evaluateRisk(inputs({ now: chainAhead, wallNow: NOW, names }));
    expect(e.dataTrusted).toBe(true);
    expect(e.warnings).toEqual([]);
    // and a silent indexer is still caught on the wall clock
    expect(evaluateRisk(inputs({ now: chainAhead, wallNow: new Date(NOW.getTime() + 3_600_000), names })).dataTrusted).toBe(false);
  });
  test("on a fork moved ahead in time, the hedger's wall-clock stamps are compared on the wall clock (F30)", () => {
    const chainAhead = new Date(NOW.getTime() + 2 * 86_400_000);
    const names = inputs().names.map((n) => ({ ...n, limitsAt: new Date(chainAhead.getTime() - 120_000) }));
    const hedger = { venueHealthy: false, venueUnhealthySince: min(1).toISOString(), unhedgedNames: { NVDA: min(1).toISOString() } };
    const fresh = evaluateRisk(inputs({ now: chainAhead, wallNow: NOW, names, hedger }));
    expect(fresh.triggers).toEqual([]); // one minute unhedged, not two days
    const later = evaluateRisk(inputs({ now: chainAhead, wallNow: new Date(NOW.getTime() + 20 * 60_000), names, hedger }));
    expect(later.triggers.map((t) => t.key).sort()).toEqual(["hedge-route:NVDA", "hedge-venue"]);
  });
  test("a healthy book triggers nothing", () => {
    const e = evaluateRisk(inputs());
    expect(e.triggers).toEqual([]);
    expect(e.warnings).toEqual([]);
  });
  test("drawdown above 15% over 30 days pauses buys, 14% does not", () => {
    expect(evaluateRisk(inputs({ pool: { current: 0.84, peak: 1, latestAt: min(2) } })).triggers.map((t) => t.key)).toEqual(["drawdown"]);
    expect(evaluateRisk(inputs({ pool: { current: 0.86, peak: 1, latestAt: min(2) } })).triggers).toEqual([]);
  });
  test("hedge venue down more than 15 minutes pauses, less does not", () => {
    const down = (m: number) => inputs({ hedger: { venueHealthy: false, venueUnhealthySince: min(m).toISOString() } });
    expect(evaluateRisk(down(16)).triggers.map((t) => t.key)).toEqual(["hedge-venue"]);
    expect(evaluateRisk(down(10)).triggers).toEqual([]);
    expect(evaluateRisk(down(10)).warnings.length).toBe(1);
  });
  test("stale hedge equity pauses only once equity was posted", () => {
    const old = { equityUsdg: 1000, asOf: new Date(NOW.getTime() - 4 * 3_600_000) };
    expect(evaluateRisk(inputs({ hedgeEquity: old })).triggers.map((t) => t.key)).toEqual(["hedge-equity-stale"]);
    expect(evaluateRisk(inputs({ hedgeEquity: { ...old, equityUsdg: 0 } })).triggers).toEqual([]);
    expect(evaluateRisk(inputs({ hedgeEquity: { ...old, asOf: min(90) } })).triggers).toEqual([]);
  });
  test("stale vol: one name pauses that name, every name pauses globally, a short staleness does not", () => {
    const base = inputs();
    const stale = (i: number, m: number) => base.names.map((n, j) => (j === i ? { ...n, volStale: true, volStaleSince: min(m) } : n));
    const one = evaluateRisk(inputs({ names: stale(0, 20) }));
    expect(one.triggers.map((t) => [t.key, t.scope.kind])).toEqual([["vol-stale:NVDA", "stock"]]);
    expect(evaluateRisk(inputs({ names: stale(0, 5) })).triggers).toEqual([]);
    const both = base.names.map((n) => ({ ...n, volStale: true, volStaleSince: min(30) }));
    expect(evaluateRisk(inputs({ names: both })).triggers.map((t) => [t.key, t.scope.kind])).toEqual([["vol-stale:all", "global"]]);
  });
  test("untrusted indexed data never starts a pause", () => {
    const e = evaluateRisk(inputs({ pool: { current: 0.5, peak: 1, latestAt: min(2) }, indexer: { indexerLastOk: min(20).toISOString(), indexerLastError: null, lastSnapshotAt: min(2).toISOString(), lagBlocks: "1" } }));
    expect(e.triggers).toEqual([]);
    expect(e.dataTrusted).toBe(false);
  });
  test("the only actions a trigger can map to are buy pauses", async () => {
    const source = await Bun.file(new URL("./risk.ts", import.meta.url)).text();
    const used = [...source.matchAll(/functionName: "(\w+)"/g)].map((m) => m[1]);
    expect(new Set(used)).toEqual(new Set(["setBuysPaused", "setSeriesBuysPaused"]));
  });
});

const enabled = Boolean(testDatabaseUrl());
(enabled ? describe : describe.skip)("risk job on the indexed tables", () => {
  let db: TestDatabase;
  beforeAll(async () => { db = (await createTestDatabase("risk"))!; await applyMigrations(db); });
  afterAll(async () => { await db.close(); });

  async function seed(drawdown: boolean) {
    await db.sql`truncate pool_nav, limits_state, ticks, series, keeper_status, hedge_equity_posts`;
    const peakAt = new Date(NOW.getTime() - 10 * 86_400_000).toISOString();
    await db.sql`insert into pool_nav (ts, block, usdg, hedge_equity, option_liability, reserve, nav, nav_per_share)
      values (${peakAt}, 1, 1, 0, 0, 0, 1, 1), (${min(1).toISOString()}, 2, 1, 0, 0, 0, 1, ${drawdown ? 0.8 : 0.99})`;
    for (const [name, stock] of [["NVDA", A.nvda], ["SPY", A.spy]] as const) {
      await db.sql`insert into limits_state (name, ts, block, stock_token, net_delta, net_gamma, net_vega, stress_loss_bps) values (${name}, ${min(1).toISOString()}, 2, ${stock}, 1, 1, 1, 10)`;
      await db.sql`insert into ticks (stock_token, name, ts, block, spot, session, fresh, vol_stale) values (${stock}, ${name}, ${min(1).toISOString()}, 2, 100, 'REGULAR', true, false)`;
    }
    await db.sql`insert into keeper_status (job, last_ok, meta) values ('indexer', ${min(0).toISOString()}, ${JSON.stringify({ lastSnapshotAt: min(1).toISOString(), lagBlocks: "1" })}::jsonb)`;
  }

  function context(chain: FakeChain, sent: { fn: string; args: readonly unknown[] }[]) {
    return chain.context({
      sql: db.sql, now: () => NOW,
      metadata: async () => ({ indexerLastOk: min(0).toISOString(), indexerLastError: null, lastSnapshotAt: min(1).toISOString(), lagBlocks: "1" }),
      tx: { submit: async (t: { data: `0x${string}` }) => {
        const d = decodeFunctionData({ abi: OptionEngineAbi, data: t.data });
        sent.push({ fn: d.functionName, args: d.args ?? [] });
        return { simulated: false };
      } },
    });
  }

  test("a 20% drawdown pauses buys once, then respects the cool-down", async () => {
    await seed(true);
    const sent: { fn: string; args: readonly unknown[] }[] = [];
    const job = createRiskJob(context(new FakeChain(), sent));
    const first = await job();
    expect(first.acted).toEqual(["drawdown"]);
    expect(sent).toEqual([{ fn: "setBuysPaused", args: [true] }]);
    await job();
    expect(sent.length).toBe(1);
  });

  test("a healthy book sends nothing and reports per-name greeks", async () => {
    await seed(false);
    const sent: { fn: string; args: readonly unknown[] }[] = [];
    const result = await createRiskJob(context(new FakeChain(), sent))();
    expect(sent).toEqual([]);
    expect((result.names as Record<string, unknown>).NVDA).toMatchObject({ netDelta: 1, stressLossBps: 10 });
  });

  test("one stale name pauses only its buyable series", async () => {
    await seed(false);
    await db.sql`update ticks set vol_stale = true where name = 'NVDA'`;
    await db.sql`insert into ticks (stock_token, name, ts, block, spot, session, fresh, vol_stale) values (${A.nvda}, 'NVDA', ${min(30).toISOString()}, 1, 100, 'REGULAR', true, true)`;
    for (const [i, stock] of [A.nvda, A.nvda, A.spy].entries()) {
      await db.sql`insert into series (id, stock_token, name, is_call, speed, tau_s, strike, token, last_accrual, buyable, archived, listed_at, listed_block, listed_tx, listed_log)
        values (${`0x${i}`.padEnd(66, "0")}, ${stock}, 'x', true, 'DAILY', 86400, 100, ${`t${i}`}, now(), true, false, now(), 1, 'tx', ${i})`;
    }
    const sent: { fn: string; args: readonly unknown[] }[] = [];
    const result = await createRiskJob(context(new FakeChain(), sent))();
    expect(result.acted).toEqual(["vol-stale:NVDA"]);
    expect(sent.map((s) => s.fn)).toEqual(["setSeriesBuysPaused", "setSeriesBuysPaused"]);
    expect(sent.map((s) => s.args[0])).toEqual(["0x0", "0x1"].map((x) => x.padEnd(66, "0")));
  });
});
