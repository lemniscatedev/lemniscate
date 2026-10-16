import { describe, expect, test } from "bun:test";
import { createPublicKey, generateKeyPairSync, verify } from "node:crypto";
import { decodeFunctionData, type Address } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { createLogger } from "../log";
import { UniswapV3HedgeAdapterAbi } from "../abi/UniswapV3HedgeAdapter";
import { ConfigurationError, loadConfig } from "../config";
import {
  ApiPerpVenue, assertHedgerKeyDistinct, createChainSpotPort, decideRehedge, depthUsdgFor, hedgerSettings, meanTick, minOutFor,
  MockPerpVenue, netDeltaFromBook, newHedgerState, postHedgeEquityOnce, pxFromTick, runHedgeCycle, snapshotRef, toWei,
  UniswapV3SpotVenue, venueSnapshot, DEFAULT_SETTINGS, type BookSeries, type BookSnapshot, type IHedgeVenue, type NameMarket,
  type PoolPrices, type SpotChainPort,
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
  test("minOutFor floors at the TWAP less slippage, both directions", () => {
    expect(minOutFor(true, 100_000_000n, 100_000_000n, 100)).toBe((99n * WAD) / 100n); // 100 USDG at $100 = 1 stock, -1%
    expect(minOutFor(false, WAD, 100_000_000n, 100)).toBe(99_000_000n);
  });
  test("depth grows with liquidity and is symmetric in order", () => {
    const sqrt = 2n ** 96n / 100_000n;
    expect(depthUsdgFor(2n * 10n ** 18n, sqrt, true)).toBeGreaterThan(depthUsdgFor(10n ** 18n, sqrt, true));
    expect(depthUsdgFor(0n, sqrt, false)).toBe(0n);
  });
});

/** A fake chain: balances move 1:1 with the TWAP price, approvals are tracked, nothing else. */
class FakePort implements SpotChainPort {
  balances = new Map<string, bigint>();
  allowances = new Map<string, bigint>();
  approvals: { token: string; amount: bigint }[] = [];
  swaps: { tokenIn: Address; tokenOut: Address; fee: number; amountIn: bigint; minOut: bigint }[] = [];
  up = true;
  prices_: PoolPrices = { twapPx: 100_000_000n, spotPx: 100_000_000n, depthUsdg: 1_000_000_000_000n };
  slipBps = 0n;
  constructor(readonly usdg: Address) {}
  async prices() { return this.prices_; }
  async balance(token: Address) { return this.balances.get(token.toLowerCase()) ?? 0n; }
  async allowance(token: Address) { return this.allowances.get(token.toLowerCase()) ?? 0n; }
  async approve(token: Address, amount: bigint) { this.approvals.push({ token, amount }); this.allowances.set(token.toLowerCase(), amount); }
  fee() { return 500; }
  async healthy() { if (!this.up) throw new Error("rpc down"); return true; }
  async swap(p: { tokenIn: Address; tokenOut: Address; fee: number; amountIn: bigint; minOut: bigint }) {
    this.swaps.push(p);
    const buy = p.tokenIn.toLowerCase() === this.usdg.toLowerCase();
    const px = this.prices_.twapPx;
    const out = (buy ? (p.amountIn * WAD) / px : (p.amountIn * px) / WAD) * (10_000n - this.slipBps) / 10_000n;
    if (out < p.minOut) throw new Error("Too little received");
    this.balances.set(p.tokenIn.toLowerCase(), (await this.balance(p.tokenIn)) - p.amountIn);
    this.balances.set(p.tokenOut.toLowerCase(), (await this.balance(p.tokenOut)) + out);
    this.allowances.set(p.tokenIn.toLowerCase(), 0n); // the adapter consumes exactly amountIn
    return { hash: `0xswap${this.swaps.length}` };
  }
}

function spotVenue(cash = 10_000_000_000n, held = 0n, maxLiquidityBps = 2500) {
  const port = new FakePort(USDG);
  port.balances.set(USDG.toLowerCase(), cash);
  port.balances.set(NVDA.toLowerCase(), held);
  return { port, venue: new UniswapV3SpotVenue(port, { usdg: USDG, stocks: [NVDA], maxLiquidityBps }) };
}

describe("UniswapV3SpotVenue (R3, R7)", () => {
  test("buys through the adapter with a TWAP floor and an exact approval, leaving no allowance", async () => {
    const { port, venue } = spotVenue();
    const fill = await venue.trade(NVDA, 5n * WAD, 100);
    expect(fill.filled).toBe(5n * WAD);
    expect(fill.px).toBe(100_000_000n);
    expect(port.swaps).toHaveLength(1);
    expect(port.swaps[0]!.amountIn).toBe(500_000_000n);
    expect(port.swaps[0]!.minOut).toBe((5n * WAD * 99n) / 100n);
    expect(port.approvals[0]).toEqual({ token: USDG, amount: 500_000_000n }); // exact, never MaxUint256
    expect(await port.allowance(USDG)).toBe(0n);
    expect(port.approvals.every((a) => a.amount < 2n ** 128n)).toBe(true);
  });
  test("sells are clamped to the held balance (spot cannot short) and return a negative fill", async () => {
    const { venue } = spotVenue(0n, 3n * WAD);
    const fill = await venue.trade(NVDA, -10n * WAD, 100);
    expect(fill.filled).toBe(-3n * WAD);
    expect(await venue.netPosition(NVDA)).toBe(0n);
  });
  test("caps each trade at a share of in-range liquidity and says how much it can take", async () => {
    const { port, venue } = spotVenue(10_000_000_000_000n, 0n, 1000); // 10% of $1M depth = $100k = 1000 stock
    port.prices_ = { ...port.prices_, depthUsdg: 1_000_000_000_000n };
    expect(await venue.maxTrade(NVDA, true)).toBe(1000n * WAD);
    const fill = await venue.trade(NVDA, 5000n * WAD, 100);
    expect(fill.filled).toBe(1000n * WAD); // partial; the rest is reported as unhedged by the service
  });
  test("refuses to trade into a pool that has drifted from its TWAP", async () => {
    const { port, venue } = spotVenue();
    port.prices_ = { ...port.prices_, spotPx: 103_000_000n };
    await expect(venue.trade(NVDA, WAD, 100)).rejects.toThrow("TWAP");
    expect(port.swaps).toHaveLength(0);
  });
  test("a swap that falls below the floor reverts and the approval is cleared", async () => {
    const { port, venue } = spotVenue();
    port.slipBps = 500n;
    port.allowances.set(USDG.toLowerCase(), 0n);
    const origApprove = port.approve.bind(port);
    port.approve = async (t, a) => { await origApprove(t, a); };
    await expect(venue.trade(NVDA, WAD, 100)).rejects.toThrow("Too little");
    expect(await port.allowance(USDG)).toBe(0n);
  });
  test("equity is wallet USDG plus stock at the TWAP", async () => {
    const { venue } = spotVenue(50_000_000n, 2n * WAD);
    expect(await venue.equityUsdg()).toBe(250_000_000n);
  });
});

describe("createChainSpotPort against a mock router (R3)", () => {
  test("approve and swap are encoded for the adapter with the exact amounts", async () => {
    const sent: { to: Address; data: `0x${string}`; label: string }[] = [];
    const reads: string[] = [];
    const clients = {
      stateClient: {
        readContract: async ({ functionName }: { functionName: string }) => { reads.push(functionName); return 0n; },
        getBlockNumber: async () => 1n,
      },
    } as never;
    const hedger = "0x00000000000000000000000000000000000000aa" as Address;
    const adapter = "0x00000000000000000000000000000000000000bb" as Address;
    const port = createChainSpotPort({
      clients, hedger, adapter, usdg: USDG, twapSeconds: 1800,
      routes: new Map([[NVDA, { pool: "0x00000000000000000000000000000000000000cc" as Address, fee: 500 }]]),
      submit: async (tx) => { sent.push(tx); return { simulated: false, hash: "0xabc" as `0x${string}` }; },
    });
    await port.approve(USDG, 123n);
    await port.swap({ tokenIn: USDG, tokenOut: NVDA, fee: 500, amountIn: 123n, minOut: 7n });
    expect(sent[0]!.to).toBe(USDG);
    expect(sent[1]!.to).toBe(adapter);
    const decoded = decodeFunctionData({ abi: UniswapV3HedgeAdapterAbi, data: sent[1]!.data });
    expect(decoded.functionName).toBe("swapExactIn");
    expect(([...decoded.args!] as unknown[]).map((a) => (typeof a === "string" ? a.toLowerCase() : a))).toEqual([USDG, NVDA, 500, 123n, 7n, hedger]);
    expect(await port.healthy()).toBe(true);
    expect(() => port.fee("0x0000000000000000000000000000000000000001" as Address)).toThrow("no Uniswap route");
  });
  test("a simulated-only swap is an error, never a fill", async () => {
    const port = createChainSpotPort({
      clients: { stateClient: {} } as never, hedger: NVDA, adapter: NVDA, usdg: USDG, twapSeconds: 60, routes: new Map(),
      submit: async () => ({ simulated: true }),
    });
    await expect(port.swap({ tokenIn: USDG, tokenOut: NVDA, fee: 500, amountIn: 1n, minOut: 0n })).rejects.toThrow("simulated");
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
      label: "UniswapV3SpotVenue",
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
    expect(port.swaps).toHaveLength(1);
    expect(ctx.records).toHaveLength(1);
    expect((ctx.records[0] as { side: string }).side).toBe("buy");
  });

  test("a closed session never trades", async () => {
    const { venue, port } = spotVenue();
    const result = await runHedgeCycle(cycleDeps([venue], book({ session: "CLOSED" })).deps);
    expect(result.names.NVDA!.action).toBe("hold");
    expect(result.names.NVDA!.reason).toBe("session_closed");
    expect(port.swaps).toHaveLength(0);
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
    expect(port.swaps).toHaveLength(0);
  });

  test("incomplete inputs fail closed", async () => {
    const { venue, port } = spotVenue();
    const result = await runHedgeCycle(cycleDeps([venue], book({ sigma: {} })).deps);
    expect(result.names.NVDA!.reason).toBe("incomplete_inputs");
    expect(port.swaps).toHaveLength(0);
  });

  test("stale ticks and unfresh prices do not trade", async () => {
    const { venue, port } = spotVenue();
    expect((await runHedgeCycle(cycleDeps([venue], book({ tickAgeMs: 20 * 60_000 })).deps)).names.NVDA!.reason).toBe("stale_inputs");
    expect((await runHedgeCycle(cycleDeps([venue], book({ fresh: false })).deps)).names.NVDA!.reason).toBe("stale_inputs");
    expect(port.swaps).toHaveLength(0);
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
    expect(port.swaps).toHaveLength(0);
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

// R5 ----------------------------------------------------------------------------------------------------------------
describe("equityPostHourly (R5)", () => {
  const posted: { equity: bigint; asOf: bigint; ref: string }[] = [];
  const post = async (equity: bigint, asOf: bigint, ref: `0x${string}`) => { posted.push({ equity, asOf, ref }); return { hash: "0xhash" }; };
  const base = { stocks: [NVDA], nowSeconds: 1_000_000, lastPostedAsOf: 0, intervalSeconds: 3600, dryRun: false, post };

  test("posts the sum of venue equity with a reproducible snapshot ref", async () => {
    posted.length = 0;
    const perp = new MockPerpVenue({ collateral: 400_000_000n, prices: new Map([[NVDA, 100_000_000n]]) });
    const { venue } = spotVenue(600_000_000n);
    const outcome = await postHedgeEquityOnce({ ...base, venues: [perp, venue] });
    expect(outcome.posted).toBe(true);
    expect(posted).toHaveLength(1);
    expect(posted[0]!.equity).toBe(1_000_000_000n);
    expect(posted[0]!.asOf).toBe(1_000_000n);
    const snapshot = await venueSnapshot([perp, venue], [NVDA], 1_000_000);
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
