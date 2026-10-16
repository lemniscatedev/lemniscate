import { describe, expect, test } from "bun:test";
import { decodeFunctionData, encodeEventTopics, encodeAbiParameters, type Address, type Hex, type TransactionReceipt } from "viem";
import { PoolAbi } from "../abi/Pool";
import { createLogger } from "../log";
import {
  createPoolSpotPort, MockPerpVenue, newHedgerState, PoolSpotVenue, postHedgeEquityOnce, runHedgeCycle, DEFAULT_SETTINGS,
  type BookSnapshot, type NameMarket, type PoolPrices, type PoolSpotPort,
} from "./index";
import type { ServiceClients } from "../chain/clients";

const WAD = 10n ** 18n;
const NVDA = "0x0000000000000000000000000000000000002001" as Address;
const POOL = "0x0000000000000000000000000000000000003001" as Address;
const USDG = "0x5fc5360d0400a0fd4f2af552add042d716f1d168" as Address;
const PX = 200_000_000n; // $200 (6 dp) per whole stock
const prices: PoolPrices = { twapPx: PX, spotPx: PX, depthUsdg: 400_000_000_000n }; // $400k moves the pool ~1%

function fakePort(start: { units?: bigint; cash?: bigint } = {}) {
  const state = { units: start.units ?? 0n, cash: start.cash ?? 1_000_000_000_000n };
  const calls: { stock: Address; target: bigint; limit: bigint }[] = [];
  const port: PoolSpotPort = {
    prices: async () => prices,
    hedgeUnits: async () => state.units,
    poolCash: async () => state.cash,
    async rebalance(stock, target, limit) {
      calls.push({ stock, target, limit });
      const buy = target > state.units;
      const moved = buy ? target - state.units : state.units - target;
      const usdg = (moved * PX) / WAD;
      state.units = target;
      state.cash = buy ? state.cash - usdg : state.cash + usdg;
      return { hash: `0x${"1".repeat(64)}`, buy, amountIn: buy ? usdg : moved, amountOut: buy ? moved : usdg, unitsAfter: target };
    },
    healthy: async () => true,
  };
  return { port, state, calls };
}

describe("PoolSpotVenue: the hedger moves the POOL's spot hedge with pool.rebalance (todo 14b, decision 19)", () => {
  test("R1 the target is the pool's held units plus the requested delta; R2 a buy passes the most USDG the pool may spend", async () => {
    const f = fakePort({ units: 2n * WAD });
    const venue = new PoolSpotVenue(f.port, { stocks: [NVDA], maxLiquidityBps: 2500 });
    const fill = await venue.trade(NVDA, 3n * WAD, 100);
    expect(f.calls).toEqual([{ stock: NVDA, target: 5n * WAD, limit: 606_000_000n }]); // 3 x $200 x 1.01
    expect(fill.filled).toBe(3n * WAD);
    expect(fill.px).toBe(PX);
    expect(await venue.netPosition(NVDA)).toBe(5n * WAD);
  });

  test("R2 a sell passes the least USDG the pool must receive and is clamped to the held units (spot cannot short)", async () => {
    const f = fakePort({ units: 2n * WAD });
    const venue = new PoolSpotVenue(f.port, { stocks: [NVDA], maxLiquidityBps: 2500 });
    const fill = await venue.trade(NVDA, -5n * WAD, 100);
    expect(f.calls).toEqual([{ stock: NVDA, target: 0n, limit: 396_000_000n }]); // 2 x $200 x 0.99
    expect(fill.filled).toBe(-2n * WAD);
  });

  test("caps each trade at a share of in-range liquidity and by the pool's cash", async () => {
    const venue = new PoolSpotVenue(fakePort().port, { stocks: [NVDA], maxLiquidityBps: 2500 });
    expect(await venue.maxTrade(NVDA, true)).toBe(500n * WAD); // 25% of $400k / $200
    const poor = new PoolSpotVenue(fakePort({ cash: 1_000_000_000n }).port, { stocks: [NVDA], maxLiquidityBps: 2500 });
    expect(await poor.maxTrade(NVDA, true)).toBe(5n * WAD); // $1,000 of cash
  });

  test("R3 no wallet funds: the venue reports zero equity and is never part of the posted hedge equity", async () => {
    const venue = new PoolSpotVenue(fakePort({ units: 9n * WAD }).port, { stocks: [NVDA], maxLiquidityBps: 2500 });
    expect(await venue.equityUsdg()).toBe(0n);
    let posted = false;
    const outcome = await postHedgeEquityOnce({
      venues: [venue], stocks: [NVDA], nowSeconds: 10_000, lastPostedAsOf: 0, intervalSeconds: 3600, dryRun: false,
      post: async () => { posted = true; return {}; },
    });
    expect(outcome).toEqual({ posted: false, reason: "no_perp_venue" });
    expect(posted).toBe(false);
  });

  test("R4 with a perp venue only the perp equity is posted", async () => {
    const perp = new MockPerpVenue({ name: "mock-perp", collateral: 5_000_000_000n, prices: new Map([[NVDA.toLowerCase(), PX]]) });
    const spot = new PoolSpotVenue(fakePort({ units: 9n * WAD }).port, { stocks: [NVDA], maxLiquidityBps: 2500 });
    let sent = 0n;
    const outcome = await postHedgeEquityOnce({
      venues: [perp, spot], stocks: [NVDA], nowSeconds: 10_000, lastPostedAsOf: 0, intervalSeconds: 3600, dryRun: false,
      post: async (equity) => { sent = equity; return { hash: "0xabc" }; },
    });
    expect(outcome.posted).toBe(true);
    expect(sent).toBe(5_000_000_000n);
  });

  test("a short call book is hedged through the pool in one cycle and the fill is recorded", async () => {
    const f = fakePort();
    const venue = new PoolSpotVenue(f.port, { stocks: [NVDA], maxLiquidityBps: 2500 });
    const market: NameMarket = { name: "NVDA", spot: 200, session: "REGULAR", fresh: true, tickAgeMs: 1000, sigma: { DAILY: 0.5 } };
    const book: BookSnapshot = { series: [{ id: "c", stock: NVDA, isCall: true, strike: 200, tauS: 86_400, speed: "DAILY", units: 100 }], markets: new Map([[NVDA, market]]) };
    const recorded: unknown[] = [];
    const result = await runHedgeCycle({
      loadBook: async () => book, navUsdg: async () => 1_000_000, venues: [venue], record: async (row) => { recorded.push(row); },
      settings: { ...DEFAULT_SETTINGS, dryRun: false }, state: newHedgerState(), now: () => Date.now(), logger: createLogger("silent"),
    });
    expect(result.names.NVDA?.action).toBe("traded");
    expect(f.calls).toHaveLength(1);
    expect(f.state.units).toBeGreaterThan(40n * WAD); // about 50 units of delta for 100 ATM daily calls
    expect(recorded).toHaveLength(1);
  });
});

describe("createPoolSpotPort", () => {
  test("encodes pool.rebalance and reads the fill from the Rebalanced event", async () => {
    let sentData: Hex = "0x";
    const topics = encodeEventTopics({ abi: PoolAbi, eventName: "Rebalanced", args: { stock: NVDA } });
    const data = encodeAbiParameters([{ type: "bool" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" }], [true, 600_000_000n, 3n * WAD, 5n * WAD]);
    const receipt = { status: "success", logs: [{ address: POOL, topics, data }] } as unknown as TransactionReceipt;
    const port = createPoolSpotPort({
      clients: { stateClient: {}, txClient: {} } as unknown as ServiceClients,
      submit: async (tx) => { sentData = tx.data; expect(tx.to).toBe(POOL); return { simulated: false, hash: `0x${"2".repeat(64)}`, receipt }; },
      pool: POOL, usdg: USDG, prices: async () => prices,
    });
    const r = await port.rebalance(NVDA, 5n * WAD, 606_000_000n);
    const decoded = decodeFunctionData({ abi: PoolAbi, data: sentData });
    expect(decoded.functionName).toBe("rebalance");
    expect(decoded.args).toEqual([NVDA, 5n * WAD, 606_000_000n]);
    expect(r).toEqual({ hash: `0x${"2".repeat(64)}`, buy: true, amountIn: 600_000_000n, amountOut: 3n * WAD, unitsAfter: 5n * WAD });
  });
});
