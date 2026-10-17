import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { decodeFunctionData, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createLogger } from "../log";
import { PoolAbi } from "../abi/Pool";
import { ConfigurationError, loadConfig } from "../config";
import {
  ApiPerpVenue, assertHedgerKeyDistinct, createChainPoolPort, decideRehedge, depthUsdgFor, healthMeta, hedgerSettings, limitFor, meanTick,
  MockPerpVenue, netDeltaFromBook, newHedgerState, postHedgeEquityOnce, pxFromTick, runHedgeCycle, snapshotRef, toWei,
  PoolSpotVenue, venueSnapshot, DEFAULT_SETTINGS, type BookSeries, type BookSnapshot, type IHedgeVenue, type NameMarket,
  type PoolHedgePort, type PoolPrices, type RebalanceOutcome,
} from "./index";

const WAD = 10n ** 18n;
const NVDA = "0x0000000000000000000000000000000000002001" as Address;
const TSLA = "0x0000000000000000000000000000000000002002" as Address;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const logger = createLogger("silent");

// R1 ----------------------------------------------------------------------------------------------------------------
describe("netDeltaFromBook (R1)", () => {
  // Hand computation: S = K = 100, sigma = 0.5, Daily tau = 1/365 y.
  // u = sqrt(1/4 + 2 / (sigma^2 tau)) = sqrt(0.25 + 2920) = 54.0416..., at S = K: call delta = (u + 1/2) / (2u), put = call - 1.
  const u = Math.sqrt(0.25 + 2 / (0.25 / 365));
  const callDelta = (u + 0.5) / (2 * u);
  const putDelta = callDelta - 1;
  const market: NameMarket = { name: "NVDA", spot: 100, session: "REGULAR", fresh: true, tickAgeMs: 1000, sigma: { DAILY: 0.5 } };
  const call: BookSeries = { id: "c", stock: NVDA, isCall: true, strike: 100, tauS: 86_400, speed: "DAILY", units: 100 };
  const put: BookSeries = { id: "p", stock: NVDA, isCall: false, strike: 100, tauS: 86_400, speed: "DAILY", units: 40 };

  test("matches the hand-computed delta of a mixed book", () => {
    const result = netDeltaFromBook([call, put], new Map([[NVDA, market]])).get(NVDA)!;
    expect(result.netDelta).toBeCloseTo(100 * callDelta + 40 * putDelta, 9);
    expect(result.netDelta).toBeCloseTo(30.648, 2);
    expect(result.complete).toBe(true);
    expect(result.seriesCount).toBe(2);
    expect(result.netGamma).toBeGreaterThan(0);
  });

  test("short puts alone want a negative stock position", () => {
    const result = netDeltaFromBook([put], new Map([[NVDA, market]])).get(NVDA)!;
    expect(result.netDelta).toBeCloseTo(40 * putDelta, 9);
    expect(result.netDelta).toBeLessThan(0);
  });

  test("a series with no sigma, or no tick, marks the name incomplete instead of guessing", () => {
    const noSigma = netDeltaFromBook([call, { ...put, speed: "WEEKLY", tauS: 604_800 }], new Map([[NVDA, market]])).get(NVDA)!;
    expect(noSigma.complete).toBe(false);
    expect(noSigma.skipped).toEqual(["p"]);
    expect(netDeltaFromBook([call], new Map()).get(NVDA)!.complete).toBe(false);
  });

  test("empty series are ignored and names stay separate", () => {
    const other = { ...call, id: "t", stock: TSLA, units: 5 };
    const markets = new Map([[NVDA, market], [TSLA, { ...market, name: "TSLA" }]]);
    const result = netDeltaFromBook([call, { ...put, units: 0 }, other], markets);
    expect(result.get(NVDA)!.seriesCount).toBe(1);
    expect(result.get(TSLA)!.netDelta).toBeCloseTo(5 * callDelta, 9);
  });
});

// R2 ----------------------------------------------------------------------------------------------------------------
describe("rehedgeBand (R2)", () => {
  const base = {
    gapUnits: 100, spot: 100, navUsdg: 1_000_000, session: "REGULAR", inputsFresh: true, nowMs: 10_000_000,
    bandBps: 50, intervalSeconds: 1800, cooldownSeconds: 120, minTradeUsdg: 25,
  };
  test("trades when the gap exceeds 0.5% of NAV", () => {
    expect(decideRehedge({ ...base, gapUnits: 51 })).toEqual({ trade: true, reason: "band" }); // $5,100 > $5,000
    expect(decideRehedge({ ...base, gapUnits: 49, lastTradeMs: base.nowMs - 600_000 })).toEqual({ trade: false, reason: "within_band" });
  });
  test("rehedges every 30 minutes in session even inside the band", () => {
    expect(decideRehedge({ ...base, gapUnits: 10, lastTradeMs: base.nowMs - 1_799_000 }).trade).toBe(false);
    expect(decideRehedge({ ...base, gapUnits: 10, lastTradeMs: base.nowMs - 1_800_000 })).toEqual({ trade: true, reason: "interval" });
  });
  test("never trades when the session is not tradable", () => {
    for (const session of ["CLOSED", "UNKNOWN", "HALTED"]) {
      expect(decideRehedge({ ...base, gapUnits: 5000, session })).toEqual({ trade: false, reason: "session_closed" });
    }
    expect(decideRehedge({ ...base, session: "EXTENDED" }).trade).toBe(true);
  });
  test("respects the minimum size, the two minute cool-down, stale inputs and a missing NAV", () => {
    expect(decideRehedge({ ...base, gapUnits: 0.1 })).toEqual({ trade: false, reason: "below_min_size" }); // $10 < $25
    expect(decideRehedge({ ...base, gapUnits: 5000, lastTradeMs: base.nowMs - 119_000 })).toEqual({ trade: false, reason: "cooldown" });
    expect(decideRehedge({ ...base, gapUnits: 5000, lastTradeMs: base.nowMs - 120_000 }).trade).toBe(true);
    expect(decideRehedge({ ...base, inputsFresh: false })).toEqual({ trade: false, reason: "stale_inputs" });
    expect(decideRehedge({ ...base, navUsdg: 0 })).toEqual({ trade: false, reason: "no_nav" });
  });
});

// R3 / R7 -----------------------------------------------------------------------------------------------------------
describe("spot math", () => {
  test("pxFromTick handles both token orders", () => {
    // stock = token0, 18 dp; USDG = token1, 6 dp. 100 USDG per stock => raw ratio 1e-10 => tick = ln(1e-10)/ln(1.0001).
    const tick = Math.round(Math.log(1e-10) / Math.log(1.0001));
    const px = pxFromTick(tick, true);
    expect(Number(px) / 1e6).toBeCloseTo(100, 0);
    const tickInv = Math.round(Math.log(1e10) / Math.log(1.0001));
    expect(Number(pxFromTick(tickInv, false)) / 1e6).toBeCloseTo(100, 0);
  });
  test("meanTick rounds toward negative infinity like the oracle", () => {
    expect(meanTick(0n, 1800n * 10n, 1800)).toBe(10);
    expect(meanTick(0n, -(1800n * 10n) - 1n, 1800)).toBe(-11);
  });
  test("limitFor: a ceiling on USDG spent when buying, a floor on USDG received when selling (R2)", () => {
    expect(limitFor(true, WAD, 100_000_000n, 100)).toBe(101_000_001n); // $100 + 1%, rounded up
    expect(limitFor(false, WAD, 100_000_000n, 100)).toBe(99_000_000n); // $100 - 1%
  });
  test("depth grows with liquidity and is symmetric in order", () => {
    const sqrt = 2n ** 96n / 100_000n;
    expect(depthUsdgFor(2n * 10n ** 18n, sqrt, true)).toBeGreaterThan(depthUsdgFor(10n ** 18n, sqrt, true));
    expect(depthUsdgFor(0n, sqrt, false)).toBe(0n);
  });
});

/** A fake pool: hedge units move 1:1 with the TWAP price, rebalance calls are recorded, and nothing of the hedger
 * wallet exists in it at all (R3). */
class FakePort implements PoolHedgePort {
  units = new Map<string, bigint>();
  cash = 10_000_000_000n;
  rebalances: { stock: Address; targetUnits: bigint; limit: bigint }[] = [];
  up = true;
  prices_: PoolPrices = { twapPx: 100_000_000n, spotPx: 100_000_000n, depthUsdg: 1_000_000_000_000n };
  /** Fraction of the requested units the pool fills, in bps (the pool may cap a buy at its own limit). */
  fillBps = 10_000n;
  async prices() { return this.prices_; }
  async hedgeUnits(stock: Address) { return this.units.get(stock.toLowerCase()) ?? 0n; }
  async poolCash() { return this.cash; }
  async healthy() { if (!this.up) throw new Error("rpc down"); return true; }
  async rebalance(p: { stock: Address; targetUnits: bigint; limit: bigint }): Promise<RebalanceOutcome> {
    this.rebalances.push(p);
    const current = await this.hedgeUnits(p.stock);
    const wantBuy = p.targetUnits > current;
    const delta = ((wantBuy ? p.targetUnits - current : current - p.targetUnits) * this.fillBps) / 10_000n;
    const usdgMoved = (delta * this.prices_.twapPx) / WAD;
    if (wantBuy ? usdgMoved > p.limit : usdgMoved < p.limit) throw new Error("limit");
    const after = wantBuy ? current + delta : current - delta;
    this.units.set(p.stock.toLowerCase(), after);
    return { hash: `0xrebalance${this.rebalances.length}`, unitsAfter: after, usdgMoved };
  }
}

function spotVenue(cash = 10_000_000_000n, held = 0n, maxLiquidityBps = 2500) {
  const port = new FakePort();
  port.cash = cash;
  port.units.set(NVDA.toLowerCase(), held);
  return { port, venue: new PoolSpotVenue(port, { maxLiquidityBps }) };
}

describe("PoolSpotVenue (R2, R3)", () => {
  test("R2: a buy calls rebalance with the target units and a USDG ceiling at the TWAP plus slippage", async () => {
    const { port, venue } = spotVenue(10_000_000_000n, 2n * WAD);
    const fill = await venue.trade(NVDA, 5n * WAD, 100);
    expect(fill.filled).toBe(5n * WAD);
    expect(fill.px).toBe(100_000_000n);
    expect(port.rebalances).toEqual([{ stock: NVDA, targetUnits: 7n * WAD, limit: 505_000_001n }]);
  });
  test("R2: a sell calls rebalance with a lower target and a USDG floor, and returns a negative fill", async () => {
    const { port, venue } = spotVenue(0n, 3n * WAD);
    const fill = await venue.trade(NVDA, -WAD, 100);
    expect(fill.filled).toBe(-WAD);
    expect(port.rebalances).toEqual([{ stock: NVDA, targetUnits: 2n * WAD, limit: 99_000_000n }]);
    expect(await venue.netPosition(NVDA)).toBe(2n * WAD);
  });
  test("sells are clamped to the held units: spot cannot short, the target never goes below zero", async () => {
    const { port, venue } = spotVenue(0n, 3n * WAD);
    const fill = await venue.trade(NVDA, -10n * WAD, 100);
    expect(fill.filled).toBe(-3n * WAD);
    expect(port.rebalances[0]!.targetUnits).toBe(0n);
  });
  test("caps each trade at a share of in-range liquidity and says how much it can take", async () => {
    const { port, venue } = spotVenue(10_000_000_000_000n, 0n, 1000); // 10% of $1M depth = $100k = 1000 stock
    port.prices_ = { ...port.prices_, depthUsdg: 1_000_000_000_000n };
    expect(await venue.maxTrade(NVDA, true)).toBe(1000n * WAD);
    const fill = await venue.trade(NVDA, 5000n * WAD, 100);
    expect(fill.filled).toBe(1000n * WAD); // partial; the rest is reported as unhedged by the service
  });
  test("a buy is also capped by the pool's own USDG", async () => {
    const { venue } = spotVenue(250_000_000n);
    expect(await venue.maxTrade(NVDA, true)).toBe(5n * WAD / 2n);
  });
  test("refuses to trade into a pool that has drifted from its TWAP", async () => {
    const { port, venue } = spotVenue();
    port.prices_ = { ...port.prices_, spotPx: 103_000_000n };
    await expect(venue.trade(NVDA, WAD, 100)).rejects.toThrow("TWAP");
    expect(port.rebalances).toHaveLength(0);
  });
  test("a rebalance the pool refuses is an error, not a fill; one that moves nothing is too", async () => {
    const { port, venue } = spotVenue();
    port.fillBps = 0n;
    await expect(venue.trade(NVDA, WAD, 100)).rejects.toThrow("moved no units");
    const refused = new PoolSpotVenue({ ...port, prices: port.prices.bind(port), hedgeUnits: port.hedgeUnits.bind(port), poolCash: port.poolCash.bind(port), healthy: port.healthy.bind(port), rebalance: async () => { throw new Error("NoCash"); } }, { maxLiquidityBps: 2500 });
    await expect(refused.trade(NVDA, WAD, 100)).rejects.toThrow("NoCash");
  });
  test("R3: no wallet funds are involved: the port has no balance or allowance, and the venue reports zero equity", async () => {
    const { port, venue } = spotVenue(10_000_000_000n, 4n * WAD);
    expect(Object.getOwnPropertyNames(Object.getPrototypeOf(port)).filter((n) => /^(balance|balanceOf|allowance|approve|swap)$/i.test(n))).toEqual([]);
    expect(await venue.equityUsdg()).toBe(0n);
    expect(venue.canShort).toBe(false);
  });
});

describe("createChainPoolPort against a mock chain (R2, R3)", () => {
  const POOL = "0x00000000000000000000000000000000000000dd" as Address;
  test("rebalance sends exactly one pool.rebalance(stock, target, limit) and reads the outcome back", async () => {
    const sent: { to: Address; data: `0x${string}`; label: string }[] = [];
    const clients = {
      stateClient: { readContract: async () => 6n * WAD, getBlockNumber: async () => 1n },
    } as never;
    const port = createChainPoolPort({
      clients, pool: POOL, usdg: USDG, twapSeconds: 1800, routes: new Map(),
      submit: async (tx) => { sent.push(tx); return { simulated: false, hash: "0xabc" as `0x${string}` }; },
    });
    const outcome = await port.rebalance({ stock: NVDA, targetUnits: 6n * WAD, limit: 7n });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe(POOL);
    expect(sent[0]!.label).toBe("hedger:rebalance");
    const decoded = decodeFunctionData({ abi: PoolAbi, data: sent[0]!.data });
    expect(decoded.functionName).toBe("rebalance");
    expect(([...decoded.args!] as unknown[]).map((a) => (typeof a === "string" ? a.toLowerCase() : a))).toEqual([NVDA, 6n * WAD, 7n]);
    expect(outcome).toEqual({ hash: "0xabc", unitsAfter: 6n * WAD, usdgMoved: 0n });
    expect(await port.healthy()).toBe(true);
  });
  test("a simulated-only rebalance is an error, never a fill", async () => {
    const port = createChainPoolPort({
      clients: { stateClient: {} } as never, pool: POOL, usdg: USDG, twapSeconds: 60, routes: new Map(),
      submit: async () => ({ simulated: true }),
    });
    await expect(port.rebalance({ stock: NVDA, targetUnits: 1n, limit: 0n })).rejects.toThrow("simulated");
  });
  test("a name with no Uniswap route has no prices", async () => {
    const port = createChainPoolPort({ clients: { stateClient: {} } as never, pool: POOL, usdg: USDG, twapSeconds: 60, routes: new Map(), submit: async () => ({ simulated: true }) });
    await expect(port.prices(NVDA)).rejects.toThrow("no Uniswap route");
  });
});

// R4 ----------------------------------------------------------------------------------------------------------------
function venuesUnderTest(): { label: string; make: () => { venue: IHedgeVenue; fund: () => void } }[] {
  return [
    {
      label: "MockPerpVenue",
      make: () => ({ venue: new MockPerpVenue({ collateral: 1_000_000_000n, prices: new Map([[NVDA, 100_000_000n]]) }), fund: () => {} }),
    },
    {
      label: "PoolSpotVenue",
      make: () => { const { venue } = spotVenue(1_000_000_000n); return { venue, fund: () => {} }; },
    },
  ];
}

describe("IHedgeVenue contract (R4): the same tests pass for the mock perp and the spot venue", () => {
  for (const { label, make } of venuesUnderTest()) {
    test(`${label}: a buy fills, moves the position and keeps equity`, async () => {
      const { venue } = make();
      const before = await venue.equityUsdg();
      expect(await venue.healthy()).toBe(true);
      const fill = await venue.trade(NVDA, 2n * WAD, 100);
      expect(fill.filled).toBe(2n * WAD);
      expect(fill.px).toBe(100_000_000n);
      expect(fill.ref).not.toBe("");
      expect(await venue.netPosition(NVDA)).toBe(2n * WAD);
      expect(await venue.equityUsdg()).toBe(before); // bought at the mark: no PnL yet
    });
    test(`${label}: a zero trade does nothing`, async () => {
      const { venue } = make();
      const fill = await venue.trade(NVDA, 0n, 100);
      expect(fill).toEqual({ ref: "", filled: 0n, px: 0n });
      expect(await venue.netPosition(NVDA)).toBe(0n);
    });
    test(`${label}: a sell reduces the position`, async () => {
      const { venue } = make();
      await venue.trade(NVDA, 3n * WAD, 100);
      const fill = await venue.trade(NVDA, -WAD, 100);
      expect(fill.filled).toBe(-WAD);
      expect(await venue.netPosition(NVDA)).toBe(2n * WAD);
    });
  }
});

describe("MockPerpVenue (R4)", () => {
  const make = (extra = {}) => new MockPerpVenue({ collateral: 1_000_000_000n, prices: new Map([[NVDA, 100_000_000n]]), ...extra });
  test("can short, and equity follows the mark", async () => {
    const venue = make();
    await venue.trade(NVDA, -10n * WAD, 100);
    expect(await venue.netPosition(NVDA)).toBe(-10n * WAD);
    venue.setPrice(NVDA, 90_000_000n); // the stock fell: the short gains $100
    expect(await venue.equityUsdg()).toBe(1_100_000_000n);
  });
  test("funding is deterministic", async () => {
    const venue = make({ fundingBpsPerHour: 1 });
    await venue.trade(NVDA, 10n * WAD, 100); // $1000 long pays 1 bp/hour
    venue.accrueFunding(10);
    expect(await venue.equityUsdg()).toBe(1_000_000_000n - 1_000_000n);
  });
  test("fill ratio and slippage are deterministic; slippage above the limit is refused", async () => {
    const venue = make({ fillBps: 5000, slippageBps: 10 });
    const fill = await venue.trade(NVDA, 4n * WAD, 100);
    expect(fill.filled).toBe(2n * WAD);
    expect(fill.px).toBe(100_100_000n);
    await expect(venue.trade(NVDA, WAD, 5)).rejects.toThrow("slippage");
  });
  test("failure injection and unhealthy state", async () => {
    const venue = make();
    venue.failNext(2);
    await expect(venue.trade(NVDA, WAD, 100)).rejects.toThrow("injected");
    await expect(venue.trade(NVDA, WAD, 100)).rejects.toThrow("injected");
    expect((await venue.trade(NVDA, WAD, 100)).filled).toBe(WAD);
    venue.setHealthy(false);
    expect(await venue.healthy()).toBe(false);
    await expect(venue.trade(NVDA, WAD, 100)).rejects.toThrow("unhealthy");
  });
});

// service -----------------------------------------------------------------------------------------------------------
function book(over: Partial<NameMarket> = {}, units = 100): BookSnapshot {
  const market: NameMarket = { name: "NVDA", spot: 100, session: "REGULAR", fresh: true, tickAgeMs: 1000, sigma: { DAILY: 0.5 }, ...over };
  return { series: [{ id: "c", stock: NVDA, isCall: true, strike: 100, tauS: 86_400, speed: "DAILY", units }], markets: new Map([[NVDA, market]]) };
}

function cycleDeps(venues: IHedgeVenue[], snapshot: BookSnapshot, settings = { ...DEFAULT_SETTINGS, dryRun: false }, nav = 1_000_000) {
  const records: unknown[] = [];
  let nowMs = 1_000_000_000;
  const state = newHedgerState();
  return {
    records, state, advance: (ms: number) => { nowMs += ms; },
    deps: { loadBook: async () => snapshot, navUsdg: async () => nav, venues, record: async (r: unknown) => { records.push(r); }, settings, state, now: () => nowMs, logger } as Parameters<typeof runHedgeCycle>[0],
  };
}

describe("runHedgeCycle (R2, R6)", () => {
  test("hedges a short call book to its delta on the spot venue and records the fill", async () => {
    const { venue, port } = spotVenue();
    const ctx = cycleDeps([venue], book());
    const result = await runHedgeCycle(ctx.deps);
    const report = result.names.NVDA!;
    expect(report.action).toBe("traded");
    expect(report.reason).toBe("band"); // ~50 stock = $5,046 > 0.5% of $1M
    expect(report.filledUnits).toBeCloseTo(report.netDelta, 4);
    expect(Math.abs(report.unhedgedUnits)).toBeLessThan(1e-6);
    expect(port.rebalances).toHaveLength(1);
    expect(ctx.records).toHaveLength(1);
    expect((ctx.records[0] as { side: string }).side).toBe("buy");
  });

  test("a closed session never trades", async () => {
    const { venue, port } = spotVenue();
    const result = await runHedgeCycle(cycleDeps([venue], book({ session: "CLOSED" })).deps);
    expect(result.names.NVDA!.action).toBe("hold");
    expect(result.names.NVDA!.reason).toBe("session_closed");
    expect(port.rebalances).toHaveLength(0);
    expect(result.names.NVDA!.unhedgedUnits).toBeGreaterThan(40); // exposure is reported, not hidden
  });

  test("the cool-down blocks a second trade, then allows it", async () => {
    const { venue } = spotVenue();
    const ctx = cycleDeps([venue], book());
    await runHedgeCycle(ctx.deps);
    ctx.deps.loadBook = async () => book({}, 300); // the book grew
    ctx.advance(60_000);
    expect((await runHedgeCycle(ctx.deps)).names.NVDA!.reason).toBe("cooldown");
    ctx.advance(61_000);
    expect((await runHedgeCycle(ctx.deps)).names.NVDA!.action).toBe("traded");
  });

  test("dry run (R6) reports the trade it would make and calls no venue.trade", async () => {
    const { venue, port } = spotVenue();
    const result = await runHedgeCycle(cycleDeps([venue], book(), { ...DEFAULT_SETTINGS, dryRun: true }).deps);
    expect(result.dryRun).toBe(true);
    expect(result.names.NVDA!.action).toBe("would_trade");
    expect(port.rebalances).toHaveLength(0);
  });

  test("incomplete inputs fail closed", async () => {
    const { venue, port } = spotVenue();
    const result = await runHedgeCycle(cycleDeps([venue], book({ sigma: {} })).deps);
    expect(result.names.NVDA!.reason).toBe("incomplete_inputs");
    expect(port.rebalances).toHaveLength(0);
  });

  test("stale ticks and unfresh prices do not trade", async () => {
    const { venue, port } = spotVenue();
    expect((await runHedgeCycle(cycleDeps([venue], book({ tickAgeMs: 20 * 60_000 })).deps)).names.NVDA!.reason).toBe("stale_inputs");
    expect((await runHedgeCycle(cycleDeps([venue], book({ fresh: false })).deps)).names.NVDA!.reason).toBe("stale_inputs");
    expect(port.rebalances).toHaveLength(0);
  });

  test("a thin pool takes only part of the trade and the rest is reported as unhedged", async () => {
    const { venue, port } = spotVenue(10_000_000_000n, 0n, 100); // 1% of $1M depth = $10k = 100 stock
    port.prices_ = { ...port.prices_, depthUsdg: 100_000_000n }; // $100 depth -> cap $1: below min? use larger
    port.prices_ = { ...port.prices_, depthUsdg: 2_000_000_000n }; // $2,000 depth, cap 1% = $20 = 0.2 stock
    const result = await runHedgeCycle(cycleDeps([venue], book({}, 1000)).deps);
    const report = result.names.NVDA!;
    expect(report.filledUnits).toBeCloseTo(0.2, 6);
    expect(report.unhedgedUnits).toBeGreaterThan(400);
    expect(report.unhedgedUsdg).toBeCloseTo(report.unhedgedUnits * 100, 6);
  });

  test("a failing venue is reported for that name and does not throw", async () => {
    const perp = new MockPerpVenue({ collateral: 1_000_000_000n, prices: new Map([[NVDA, 100_000_000n]]) });
    perp.failNext();
    const result = await runHedgeCycle(cycleDeps([perp], book()).deps);
    expect(result.names.NVDA!.action).toBe("failed");
  });

  test("prefers the perp venue and shorts when puts dominate; spot alone holds at zero", async () => {
    const putBook: BookSnapshot = { ...book(), series: [{ id: "p", stock: NVDA, isCall: false, strike: 100, tauS: 86_400, speed: "DAILY", units: 100 }] };
    const perp = new MockPerpVenue({ collateral: 1_000_000_000n, prices: new Map([[NVDA, 100_000_000n]]) });
    const { venue: spot, port } = spotVenue();
    const result = await runHedgeCycle(cycleDeps([perp, spot], putBook).deps);
    expect(result.names.NVDA!.venue).toBe("mock-perp");
    expect(await perp.netPosition(NVDA)).toBeLessThan(0n);
    const spotOnly = await runHedgeCycle(cycleDeps([spotVenue().venue], putBook).deps);
    expect(spotOnly.names.NVDA!.reason).toBe("below_min_size"); // target clamps to 0, nothing to sell
    expect(port.rebalances).toHaveLength(0);
  });

  test("tracks how long a venue has been unhealthy", async () => {
    const perp = new MockPerpVenue({ collateral: 1n, prices: new Map([[NVDA, 100_000_000n]]) });
    perp.setHealthy(false);
    const ctx = cycleDeps([perp], book({ session: "CLOSED" }));
    const first = await runHedgeCycle(ctx.deps);
    ctx.advance(16 * 60_000);
    const second = await runHedgeCycle(ctx.deps);
    expect(second.unhealthyVenues["mock-perp"]).toBe(first.unhealthyVenues["mock-perp"]);
    perp.setHealthy(true);
    expect((await runHedgeCycle(ctx.deps)).unhealthyVenues).toEqual({});
  });
});

describe("runHedgeCycle on the pool: targets from engine.netGreeks, health meta (R1, R2)", () => {
  test("R1: the target is the on-chain delta of the outstanding options (holders' long side), not a recomputation", async () => {
    const { venue, port } = spotVenue();
    const ctx = cycleDeps([venue], book());
    ctx.deps.chainDelta = async () => 80;
    const report = (await runHedgeCycle(ctx.deps)).names.NVDA!;
    expect(report.netDelta).toBe(80);
    expect(report.action).toBe("traded");
    expect(port.rebalances).toEqual([{ stock: NVDA, targetUnits: 80n * WAD, limit: 8_080_000_001n }]);
    expect(await venue.netPosition(NVDA)).toBe(80n * WAD);
  });
  test("R1: negative chain delta (net long puts) wants no spot: the pool sells down to zero and not below", async () => {
    const { venue, port } = spotVenue(0n, 30n * WAD);
    const ctx = cycleDeps([venue], book());
    ctx.deps.chainDelta = async () => -12;
    await runHedgeCycle(ctx.deps);
    expect(port.rebalances).toEqual([{ stock: NVDA, targetUnits: 0n, limit: 2_970_000_000n }]);
  });
  test("R1: a name whose options are gone is hedged back to zero even with no series in the book", async () => {
    const { venue, port } = spotVenue(0n, 40n * WAD);
    const ctx = cycleDeps([venue], { series: [], markets: book().markets });
    ctx.deps.chainDelta = async () => 0;
    const report = (await runHedgeCycle(ctx.deps)).names.NVDA!;
    expect(report.action).toBe("traded");
    expect(port.rebalances[0]!.targetUnits).toBe(0n);
  });
  test("an unreadable engine fails closed: the name is not traded", async () => {
    const { venue, port } = spotVenue();
    const ctx = cycleDeps([venue], book());
    ctx.deps.chainDelta = async () => { throw new Error("rpc"); };
    const report = (await runHedgeCycle(ctx.deps)).names.NVDA!;
    expect(report.action).toBe("hold");
    expect(report.reason).toBe("incomplete_inputs");
    expect(port.rebalances).toHaveLength(0);
  });
  test("dry run (R6) never calls rebalance", async () => {
    const { venue, port } = spotVenue();
    const ctx = cycleDeps([venue], book(), { ...DEFAULT_SETTINGS, dryRun: true });
    ctx.deps.chainDelta = async () => 80;
    expect((await runHedgeCycle(ctx.deps)).names.NVDA!.action).toBe("would_trade");
    expect(port.rebalances).toHaveLength(0);
  });
  test("the risk monitor's meta: healthy, then unhealthy with the time it went down, reported before any other work", async () => {
    const { venue, port } = spotVenue();
    const seen: unknown[] = [];
    const ctx = cycleDeps([venue], book({ session: "CLOSED" }));
    ctx.deps.onHealth = async (meta) => { seen.push(meta); };
    expect(await runHedgeCycle(ctx.deps)).toMatchObject({ venueHealthy: true, venueUnhealthySince: null });
    port.up = false;
    const down = await runHedgeCycle(ctx.deps);
    ctx.advance(60_000);
    const stillDown = await runHedgeCycle(ctx.deps);
    expect(down.venueHealthy).toBe(false);
    expect(stillDown.venueUnhealthySince).toBe(down.venueUnhealthySince!); // the original start, not reset each cycle
    expect(seen).toEqual([
      { venueHealthy: true, venueUnhealthySince: null },
      { venueHealthy: false, venueUnhealthySince: down.venueUnhealthySince },
      { venueHealthy: false, venueUnhealthySince: down.venueUnhealthySince },
    ]);
    port.up = true;
    expect((await runHedgeCycle(ctx.deps)).venueHealthy).toBe(true);
  });
  test("healthMeta takes the earliest of several down venues", () => {
    expect(healthMeta(new Map([["a", 2_000], ["b", 1_000]]))).toEqual({ venueHealthy: false, venueUnhealthySince: new Date(1_000).toISOString() });
    expect(healthMeta(new Map())).toEqual({ venueHealthy: true, venueUnhealthySince: null });
  });
});

// R5 ----------------------------------------------------------------------------------------------------------------
describe("equityPostHourly (R5)", () => {
  const posted: { equity: bigint; asOf: bigint; ref: string }[] = [];
  const post = async (equity: bigint, asOf: bigint, ref: `0x${string}`) => { posted.push({ equity, asOf, ref }); return { hash: "0xhash" }; };
  const base = { stocks: [NVDA], nowSeconds: 1_000_000, lastPostedAsOf: 0, intervalSeconds: 3600, dryRun: false, post };

  test("R4: posts the perp venue equity only (pool-held spot is valued on chain) with a reproducible snapshot ref", async () => {
    posted.length = 0;
    const perp = new MockPerpVenue({ collateral: 400_000_000n, prices: new Map([[NVDA, 100_000_000n]]) });
    const outcome = await postHedgeEquityOnce({ ...base, venues: [perp] });
    expect(outcome.posted).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.equity).toBe(400_000_000n);
    expect(posted[0]!.asOf).toBe(1_000_000n);
    const snapshot = await venueSnapshot([perp], [NVDA], 1_000_000);
    expect(posted[0]!.ref).toBe(snapshotRef(snapshot));
    expect(posted[0]!.ref).toMatch(/^0x[0-9a-f]{64}$/);
  });

  test("once per interval", async () => {
    posted.length = 0;
    const perp = new MockPerpVenue({ collateral: 1n, prices: new Map([[NVDA, 1n]]) });
    const outcome = await postHedgeEquityOnce({ ...base, venues: [perp], lastPostedAsOf: 1_000_000 - 3599 });
    expect(outcome).toEqual({ posted: false, reason: "interval" });
    expect(posted).toHaveLength(0);
    expect((await postHedgeEquityOnce({ ...base, venues: [perp], lastPostedAsOf: 1_000_000 - 3600 })).posted).toBe(true);
  });

  test("fails closed when any venue is unhealthy or unreadable", async () => {
    posted.length = 0;
    const perp = new MockPerpVenue({ collateral: 1_000_000n, prices: new Map([[NVDA, 1n]]) });
    const { venue } = spotVenue();
    perp.setHealthy(false);
    expect(await postHedgeEquityOnce({ ...base, venues: [venue, perp] })).toEqual({ posted: false, reason: "venue_unhealthy", unhealthy: ["mock-perp"] });
    const broken: IHedgeVenue = { ...venue, name: "broken", healthy: async () => true, equityUsdg: async () => { throw new Error("rpc"); }, netPosition: async () => 0n, trade: venue.trade.bind(venue) };
    expect((await postHedgeEquityOnce({ ...base, venues: [broken] })).posted).toBe(false);
    expect(posted).toHaveLength(0);
  });

  test("dry run computes but does not post", async () => {
    posted.length = 0;
    const perp = new MockPerpVenue({ collateral: 5n, prices: new Map([[NVDA, 1n]]) });
    const outcome = await postHedgeEquityOnce({ ...base, venues: [perp], dryRun: true });
    expect(outcome).toMatchObject({ posted: false, reason: "dry_run", equityUsdg: 5n });
    expect(posted).toHaveLength(0);
  });
});

// R6 ----------------------------------------------------------------------------------------------------------------
describe("config (R6)", () => {
  const K1 = "0x" + "11".repeat(32);
  const K2 = "0x" + "22".repeat(32);
  test("refuses to start when the hedger key is the keeper key", () => {
    expect(() => assertHedgerKeyDistinct({ HEDGER_PRIVATE_KEY: K1, KEEPER_PRIVATE_KEY: K1 })).toThrow(ConfigurationError);
    expect(() => assertHedgerKeyDistinct({ HEDGER_PRIVATE_KEY: K1, KEEPER_PRIVATE_KEY: K2 })).not.toThrow();
    expect(privateKeyToAccount(K1 as `0x${string}`).address).not.toBe(privateKeyToAccount(K2 as `0x${string}`).address);
  });
  test("defaults are dry run, 50 bps, 30 minutes, 2 minute cool-down", () => {
    const config = loadConfig({ DATABASE_URL: "postgres://x/y", POSTGRES_PASSWORD: "p" });
    expect(hedgerSettings(config)).toMatchObject({ dryRun: true, bandBps: 50, intervalSeconds: 1800, cooldownSeconds: 120, equityIntervalSeconds: 3600 });
    expect(hedgerSettings(loadConfig({ DATABASE_URL: "postgres://x/y", POSTGRES_PASSWORD: "p", HEDGER_DRY_RUN: "0" })).dryRun).toBe(false);
  });
  test("toWei rounds and keeps sign", () => {
    expect(toWei(1.5)).toBe(1_500_000_000_000_000_000n);
    expect(toWei(-0.25)).toBe(-250_000_000_000_000_000n);
  });
});

// ApiPerpVenue ------------------------------------------------------------------------------------------------------
describe("ApiPerpVenue (mocked HTTP)", () => {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = privateKey.export({ format: "der", type: "pkcs8" }).subarray(-32).toString("hex");
  const requests: { url: string; init: RequestInit }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    requests.push({ url, init });
    const path = new URL(url).pathname;
    const body: Record<string, unknown> = {
      "/v1/positions": { positions: [{ market: "NVDA-USD", size: "-1.5" }] },
      "/v1/account": { equity: "1234.5" },
      "/v1/markets": { markets: [{}] },
      "/v1/orders": { id: "ord-1", filled: "2.0", avgPrice: "101.25" },
    };
    return new Response(JSON.stringify(body[path] ?? {}), { status: path === "/v1/fail" ? 500 : 200 });
  }) as unknown as typeof fetch;
  const venue = new ApiPerpVenue({ baseUrl: "https://perp.test", apiKeyId: "key-1", seedHex: seed, markets: new Map([[NVDA, "NVDA-USD"]]), fetchImpl, now: () => 1234 });

  test("reads positions and equity, orders with signed requests, and never exposes the seed", async () => {
    expect(await venue.netPosition(NVDA)).toBe(-1_500_000_000_000_000_000n);
    expect(await venue.equityUsdg()).toBe(1_234_500_000n);
    expect(await venue.healthy()).toBe(true);
    const fill = await venue.trade(NVDA, -2n * WAD, 50);
    expect(fill).toEqual({ ref: "ord-1", filled: -2n * WAD, px: 101_250_000n });
    const order = requests.at(-1)!;
    const headers = order.init.headers as Record<string, string>;
    expect(JSON.parse(order.init.body as string)).toMatchObject({ market: "NVDA-USD", side: "sell", size: "2.000000000000000000", maxSlippageBps: 50 });
    const message = Buffer.from(`1234POST/v1/orders${order.init.body as string}`);
    expect(verify(null, message, createPublicKey(publicKey.export({ format: "pem", type: "spki" })), Buffer.from(headers["x-signature"]!, "base64"))).toBe(true);
    expect(JSON.stringify(venue)).not.toContain(seed);
    expect(String(venue)).not.toContain(seed);
  });
  test("an HTTP error makes the venue unhealthy and a bad seed is rejected", async () => {
    const down = new ApiPerpVenue({ baseUrl: "https://perp.test", apiKeyId: "k", seedHex: seed, markets: new Map(), fetchImpl: (async () => new Response("no", { status: 503 })) as unknown as typeof fetch });
    expect(await down.healthy()).toBe(false);
    expect(() => new ApiPerpVenue({ baseUrl: "x", apiKeyId: "k", seedHex: "zz", markets: new Map() })).toThrow("32 bytes");
  });
});

describe("lane B hedger bounds (review F03/F17/F27, decision 39): reverts back off instead of retrying", () => {
  function refusing(message: string) {
    const { port, venue } = spotVenue();
    let calls = 0;
    const real = port.rebalance.bind(port);
    let refuse = true;
    port.rebalance = async (p) => { calls++; if (refuse) throw new Error(`execution reverted: ${message}`); return real(p); };
    return { venue, calls: () => calls, allow: () => { refuse = false; } };
  }

  test("HedgerFrozen: no trade is tried for an hour, the name is reported unhedged, then it resumes", async () => {
    const r = refusing("HedgerFrozen()");
    const ctx = cycleDeps([r.venue], book());
    const first = await runHedgeCycle(ctx.deps);
    expect(first.names.NVDA!.reason).toBe("hedger_halted");
    expect(first.halted).toMatchObject({ reason: "HedgerFrozen" });
    expect(Object.keys(first.unhedged)).toEqual(["NVDA"]);
    for (let i = 0; i < 10; i++) { ctx.advance(5 * 60_000); await runHedgeCycle(ctx.deps); } // 50 minutes of cycles
    expect(r.calls()).toBe(1);
    r.allow();
    ctx.advance(15 * 60_000);
    expect((await runHedgeCycle(ctx.deps)).names.NVDA!.action).toBe("traded");
  });

  test("HedgeLossBudget: backs off until the next UTC day", async () => {
    const r = refusing("HedgeLossBudget(5000000000, 5000000000)");
    const ctx = cycleDeps([r.venue], book());
    const first = await runHedgeCycle(ctx.deps);
    const until = Date.parse(first.halted!.until);
    expect(until % 86_400_000).toBe(0);
    expect(until).toBeGreaterThan(1_000_000_000);
    ctx.advance(until - 1_000_000_000 - 60_000);
    await runHedgeCycle(ctx.deps);
    expect(r.calls()).toBe(1);
  });

  test("PerpEquityCap on an equity post: no post for an hour, reported as halted", async () => {
    const perp = new MockPerpVenue({ collateral: 1_000_000n, prices: new Map([[NVDA, 1n]]) });
    let posts = 0;
    const state = newHedgerState();
    const input = {
      venues: [perp], stocks: [NVDA], nowSeconds: 2_000_000, lastPostedAsOf: 0, intervalSeconds: 3600, dryRun: false, state,
      post: async () => { posts++; throw new Error("execution reverted: PerpEquityCap(900000000, 100000000)"); },
    };
    expect(await postHedgeEquityOnce(input)).toMatchObject({ posted: false, reason: "halted" });
    expect(await postHedgeEquityOnce({ ...input, nowSeconds: 2_000_000 + 1800 })).toMatchObject({ posted: false, reason: "halted" });
    expect(posts).toBe(1);
    await expect(postHedgeEquityOnce({ ...input, nowSeconds: 2_000_000 + 3601, post: async () => { throw new Error("rpc down"); } })).rejects.toThrow("rpc down");
  });
});
