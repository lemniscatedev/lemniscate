import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { createLogger } from "../log";
import { evaluateRisk, type RiskInputs } from "../keeper/jobs/risk";
import {
  assertAllRouted, DEFAULT_SETTINGS, newHedgerState, PoolSpotVenue, PRIMARY_FEES, resolveRoutes, runHedgeCycle, unroutedNames,
  type BookSnapshot, type PoolHedgePort, type PoolPrices,
} from "./index";

const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const AAPL = "0x0000000000000000000000000000000000002005" as Address;
const NVDA = "0x0000000000000000000000000000000000002001" as Address;
const AAPL_POOL = "0x00000000000000000000000000000000000000a5" as Address;
const ZERO = "0x0000000000000000000000000000000000000000";

/** A factory that knows the pools given as `${stock}:${fee}` -> pool. */
function factory(known: Record<string, string>) {
  const calls: string[] = [];
  return {
    calls,
    clients: { stateClient: { readContract: async (p: { args: [Address, Address, number] }) => {
      const key = `${p.args[0].toLowerCase()}:${p.args[2]}`;
      calls.push(key);
      return known[key] ?? ZERO;
    } } } as never,
  };
}

describe("F30 hedge routes", () => {
  test("AAPL is a launch name with a 0.05% route (500), like the others", () => {
    expect(PRIMARY_FEES.AAPL).toBe(500);
  });

  test("resolveRoutes routes AAPL and the reviewed deployment pool wins over the table", async () => {
    const f = factory({ [`${AAPL}:500`]: AAPL_POOL, [`${NVDA}:3000`]: "0x00000000000000000000000000000000000000f1" });
    const routes = await resolveRoutes(f.clients, USDG, [
      { name: "AAPL", stock: AAPL }, // table fee
      { name: "NVDA", stock: NVDA, poolFee: 3000, uniPool: "0x00000000000000000000000000000000000000F1" as Address }, // deploy config fee
    ]);
    expect(routes.get(AAPL)).toEqual({ pool: AAPL_POOL, fee: 500 });
    expect(routes.get(NVDA)?.fee).toBe(3000);
  });

  test("a factory pool that is not the reviewed pool stops the hedger instead of trading against it", async () => {
    const f = factory({ [`${AAPL}:500`]: "0x00000000000000000000000000000000000000bd" });
    await expect(resolveRoutes(f.clients, USDG, [{ name: "AAPL", stock: AAPL, uniPool: AAPL_POOL }])).rejects.toThrow("not the reviewed deployment pool");
  });

  test("startup fails when any deployed stock has no route, naming it", async () => {
    const f = factory({});
    const stocks = [{ name: "AAPL", stock: AAPL }, { name: "ZZZ", stock: NVDA }];
    const routes = await resolveRoutes(f.clients, USDG, stocks);
    expect(unroutedNames(stocks, routes)).toEqual(["AAPL", "ZZZ"]);
    expect(() => assertAllRouted(stocks, routes)).toThrow("AAPL, ZZZ");
  });

  test("a name whose venue cannot route is reported unhedged from the first pass, and keeps its start time", async () => {
    const port: PoolHedgePort = {
      prices: async () => { throw new Error("no Uniswap route configured"); },
      hedgeUnits: async () => 0n, poolCash: async () => 10_000_000_000n,
      rebalance: async () => { throw new Error("unused"); }, healthy: async () => true,
    } as unknown as PoolHedgePort;
    const venue = new PoolSpotVenue(port, { maxLiquidityBps: 2500 });
    const snapshot: BookSnapshot = {
      series: [{ id: "c", stock: AAPL, isCall: true, strike: 100, tauS: 86_400, speed: "DAILY", units: 100 }],
      markets: new Map([[AAPL, { name: "AAPL", spot: 100, session: "REGULAR", fresh: true, tickAgeMs: 1000, sigma: { DAILY: 0.5 } }]]),
    };
    let now = 1_000_000_000;
    const seen: Record<string, string>[] = [];
    const deps = {
      loadBook: async () => snapshot, navUsdg: async () => 1_000_000, venues: [venue], record: async () => undefined,
      settings: { ...DEFAULT_SETTINGS, dryRun: false }, state: newHedgerState(), now: () => now, logger: createLogger("silent"),
      onUnhedged: async (u: Record<string, string>) => { seen.push(u); },
    } as Parameters<typeof runHedgeCycle>[0];
    const first = await runHedgeCycle(deps);
    expect(first.names.AAPL).toMatchObject({ action: "failed", reason: "trade_failed" });
    expect(Object.keys(first.unhedged)).toEqual(["AAPL"]);
    now += 20 * 60_000;
    const second = await runHedgeCycle(deps);
    expect(second.unhedged.AAPL).toBe(first.unhedged.AAPL); // the original start, not reset
    expect(seen.length).toBe(2);
  });

  test("the risk monitor pauses buys on that name after 15 minutes, and warns before", () => {
    const NOW = new Date("2026-10-16T15:00:00Z");
    const min = (m: number) => new Date(NOW.getTime() - m * 60_000).toISOString();
    const base: RiskInputs = {
      now: NOW,
      indexer: { indexerLastOk: min(1), indexerLastError: null, lastSnapshotAt: min(2), lagBlocks: "2" },
      pool: { current: 1, peak: 1, latestAt: new Date(min(2)) },
      names: [
        { name: "AAPL", stockToken: AAPL, netDelta: 1, netGamma: 0, netVega: 0, stressLossBps: 0, limitsAt: new Date(min(2)), session: "REGULAR", fresh: true, volStale: false, volStaleSince: null },
        { name: "NVDA", stockToken: NVDA, netDelta: 1, netGamma: 0, netVega: 0, stressLossBps: 0, limitsAt: new Date(min(2)), session: "REGULAR", fresh: true, volStale: false, volStaleSince: null },
      ],
      hedgeEquity: null, hedger: { venueHealthy: true, venueUnhealthySince: null, unhedgedNames: { AAPL: min(16) } },
    };
    const paused = evaluateRisk(base);
    expect(paused.triggers.map((t) => [t.key, t.scope.kind])).toEqual([["hedge-route:AAPL", "stock"]]);
    const early = evaluateRisk({ ...base, hedger: { ...base.hedger!, unhedgedNames: { AAPL: min(5) } } });
    expect(early.triggers).toEqual([]);
    expect(early.warnings.join()).toContain("AAPL");
  });
});
