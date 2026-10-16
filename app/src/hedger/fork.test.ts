import { describe, expect, test } from "bun:test";
import { createPublicClient, http, type Address } from "viem";
import { createChainSpotPort, resolveRoutes } from "./index";

const FORK_RPC_URL = process.env.FORK_RPC_URL;
// FORK_STOCK_ADDRESS: the Stock Token to read (for example SPY); its address is not hard coded here.
const FORK_STOCK = process.env.FORK_STOCK_ADDRESS as Address | undefined;
const suite = FORK_RPC_URL && FORK_STOCK ? describe : describe.skip;
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168" as Address;
const STOCKS = [
  { name: process.env.FORK_STOCK_NAME ?? "SPY", stock: FORK_STOCK as Address },
];

// Read-only: resolves the real primary pools through the factory and reads TWAP, spot and depth. Nothing is sent.
suite("Uniswap spot prices on a fork (R3, needs FORK_RPC_URL)", () => {
  test("TWAP and spot agree within 1% and depth is positive on SPY", async () => {
    const stateClient = createPublicClient({ transport: http(FORK_RPC_URL!) });
    const clients = { stateClient } as never;
    const routes = await resolveRoutes(clients, USDG, STOCKS);
    expect(routes.size).toBe(1);
    const port = createChainSpotPort({
      clients, hedger: USDG, adapter: USDG, usdg: USDG, routes, twapSeconds: 1800,
      submit: async () => { throw new Error("read-only test"); },
    });
    for (const { stock } of STOCKS) {
      const prices = await port.prices(stock);
      const deviation = Math.abs(Number(prices.spotPx - prices.twapPx)) / Number(prices.twapPx);
      expect(prices.twapPx).toBeGreaterThan(0n);
      expect(deviation).toBeLessThan(0.01);
      expect(prices.depthUsdg).toBeGreaterThan(0n);
    }
  }, 60_000);
});
