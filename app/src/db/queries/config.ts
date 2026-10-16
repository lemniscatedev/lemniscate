import type { ApiDependencies } from "../../api/types";
import { asRows, numberValue } from "../../api/types";
import { isLaunched } from "../../config/launch";

export const EXPLORER_URL = "https://robinhoodchain.blockscout.com";

export async function runtimeConfigResponse(deps: ApiDependencies) {
  const [marketResult, launchResult] = await Promise.all([
    deps.sql`select id, symbol, token, stock from markets order by id`,
    deps.sql`select symbol, launched from market_launch`,
  ]);
  const rows = asRows<Record<string, unknown>>(marketResult);
  const launchBySymbol = new Map(asRows<Record<string, unknown>>(launchResult).map((row) => [
    String(row.symbol).toUpperCase(), row.launched === true,
  ]));
  const marketRows = rows.length > 0
    ? rows
    : deps.deployment.markets.map((market) => ({
      id: market.id,
      symbol: market.symbol,
      token: market.token,
      stock: market.stock,
    }));

  return {
    chainId: deps.config.CHAIN_ID,
    network: deps.config.NETWORK,
    ...(deps.config.NETWORK === "fork" && deps.deployment.forkProof
      ? { forkProof: deps.deployment.forkProof }
      : {}),
    rpcUrl: deps.config.PUBLIC_RPC_URL,
    explorerUrl: EXPLORER_URL,
    contracts: {
      engine: deps.deployment.contracts.engine,
      vault: deps.deployment.contracts.vault,
      lens: deps.deployment.contracts.lens,
      usdg: deps.deployment.contracts.usdg,
      marketHours: deps.deployment.contracts.marketHours,
    },
    markets: marketRows.filter((market) => isLaunched(String(market.symbol), launchBySymbol.get(String(market.symbol).toUpperCase()))).map((market) => ({
      id: numberValue(market.id),
      symbol: String(market.symbol),
      token: String(market.token).toLowerCase(),
      stock: String(market.stock).toLowerCase(),
      decimals: 18 as const,
    })),
    usdgDecimals: 6 as const,
    writerPoolDecimals: 12 as const,
    features: { publicDeposits: false, shorts: false, limitOrders: false, ratio: false },
  };
}
