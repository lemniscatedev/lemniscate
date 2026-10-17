import { parseAbi, type Address } from "viem";
import type { ServiceClients } from "../chain/clients";
import type { SpotRoute } from "./uniswap-spot";

/** Uniswap v3 factory on Robinhood Chain (chain-facts R4). */
export const UNISWAP_V3_FACTORY: Address = "0x1f7d7550b1b028f7571e69a784071f0205fd2efa";

/** Primary pool fee per launch name: the pools with real depth and a 7200-slot oracle (chain-facts R4; AAPL 0.05% from
 * docs/research/launch-names.md). A deployment entry's own poolFee/uniPool (the reviewed deploy config) wins over this table. */
export const PRIMARY_FEES: Readonly<Record<string, number>> = { NVDA: 500, TSLA: 3000, SPY: 500, QQQ: 500, AAPL: 500 };

const factoryAbi = parseAbi(["function getPool(address tokenA, address tokenB, uint24 fee) view returns (address)"]);

export interface RoutedStock {
  name: string;
  stock: Address;
  /** The reviewed pool and fee tier from the deployment, when the deployment file carries them. */
  uniPool?: Address | undefined;
  poolFee?: number | undefined;
}

/** Resolves each stock's primary USDG pool from the factory and checks it against the reviewed deployment pool. */
export async function resolveRoutes(
  clients: Pick<ServiceClients, "stateClient">,
  usdg: Address,
  stocks: readonly RoutedStock[],
): Promise<Map<Address, SpotRoute>> {
  const routes = new Map<Address, SpotRoute>();
  for (const { name, stock, uniPool, poolFee } of stocks) {
    const fee = poolFee ?? PRIMARY_FEES[name];
    if (!fee) continue;
    const pool = await clients.stateClient.readContract({ address: UNISWAP_V3_FACTORY, abi: factoryAbi, functionName: "getPool", args: [stock, usdg, fee] });
    if (uniPool && pool.toLowerCase() !== uniPool.toLowerCase()) {
      throw new Error(`Hedge route for ${name}: the factory pool ${pool} at fee ${fee} is not the reviewed deployment pool ${uniPool}`);
    }
    if (/^0x0{40}$/.test(pool)) continue;
    routes.set(stock.toLowerCase() as Address, { pool, fee });
  }
  return routes;
}

/** Names of deployed stocks with no hedge route. The hedger refuses to start while this is not empty (F30): an unrouted
 * name is never hedged, and its whole delta would sit on the pool unnoticed. */
export function unroutedNames(stocks: readonly { name: string; stock: Address }[], routes: ReadonlyMap<Address, SpotRoute>): string[] {
  return stocks.filter((entry) => !routes.has(entry.stock.toLowerCase() as Address)).map((entry) => entry.name);
}

export function assertAllRouted(stocks: readonly { name: string; stock: Address }[], routes: ReadonlyMap<Address, SpotRoute>): void {
  const missing = unroutedNames(stocks, routes);
  if (missing.length) {
    throw new Error(`No Uniswap hedge route for ${missing.join(", ")}: add its pool fee to the deployment file (stocks[].poolFee / uniPool) before starting the hedger`);
  }
}
