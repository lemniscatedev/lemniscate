import { parseAbi, type Address } from "viem";
import type { ServiceClients } from "../chain/clients";
import type { SpotRoute } from "./uniswap-spot";

/** Uniswap v3 factory on Robinhood Chain (chain-facts R4). */
export const UNISWAP_V3_FACTORY: Address = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";

/** Primary pool fee per name: the pools with real depth and a 7200-slot oracle (chain-facts R4). */
export const PRIMARY_FEES: Readonly<Record<string, number>> = { NVDA: 500, TSLA: 3000, SPY: 500, QQQ: 500 };

const factoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);

/** Resolves each stock's primary USDG pool from the factory. Names without a known fee are not hedged on spot. */
export async function resolveRoutes(
  clients: Pick<ServiceClients, "stateClient">,
  usdg: Address,
  stocks: readonly { name: string; stock: Address }[],
): Promise<Map<Address, SpotRoute>> {
  const routes = new Map<Address, SpotRoute>();
  for (const { name, stock } of stocks) {
    const fee = PRIMARY_FEES[name];
    if (!fee) continue;
    const pool = await clients.stateClient.readContract({ address: UNISWAP_V3_FACTORY, abi: factoryAbi, functionName: "getPool", args: [stock, usdg, fee] });
    if (/^0x0{40}$/.test(pool)) continue;
    routes.set(stock.toLowerCase() as Address, { pool, fee });
  }
  return routes;
}
