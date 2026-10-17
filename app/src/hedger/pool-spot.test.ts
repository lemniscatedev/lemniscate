import { describe, expect, test } from "bun:test";
import type { Address } from "viem";
import { MockPerpVenue, PoolSpotVenue, postHedgeEquityOnce, type PoolHedgePort, type PoolPrices } from "./index";

const WAD = 10n ** 18n;
const NVDA = "0x0000000000000000000000000000000000002001" as Address;
const PX = 200_000_000n; // $200 (6 dp) per whole stock
const prices: PoolPrices = { twapPx: PX, spotPx: PX, depthUsdg: 400_000_000_000n };

function poolHolding(units: bigint): PoolHedgePort {
  return {
    prices: async () => prices,
    hedgeUnits: async () => units,
    poolCash: async () => 1_000_000_000_000n,
    rebalance: async () => { throw new Error("not used"); },
    healthy: async () => true,
  };
}

// Kept from todo 23 when the two hedger implementations were merged (todo 20c): the pool's spot hedge is valued on
// chain inside NAV, so only perp venues are ever posted as hedge equity (decision 19).
describe("hedge equity posts only perp venues (decision 19)", () => {
  test("R3 no perp venue: nothing is posted, even though the pool holds stock", async () => {
    const venue = new PoolSpotVenue(poolHolding(9n * WAD), { maxLiquidityBps: 2500 });
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
    const spot = new PoolSpotVenue(poolHolding(9n * WAD), { maxLiquidityBps: 2500 });
    let sent = 0n;
    const outcome = await postHedgeEquityOnce({
      venues: [perp, spot], stocks: [NVDA], nowSeconds: 10_000, lastPostedAsOf: 0, intervalSeconds: 3600, dryRun: false,
      post: async (equity) => { sent = equity; return { hash: "0xabc" }; },
    });
    expect(outcome.posted).toBe(true);
    expect(sent).toBe(5_000_000_000n);
  });
});
