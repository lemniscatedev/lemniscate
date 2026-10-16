import { expect, test } from "bun:test";
import type { ApiDependencies } from "../../api/types";
import { runtimeConfigResponse } from "./config";

const deploymentMarket = (id: number, symbol: string) => ({
  id, symbol, token: `0x${String(id).padStart(40, "0")}`, stock: `0x${String(id + 10).padStart(40, "0")}`,
});

function depsFor(marketRows: Array<Record<string, unknown>>, launchRows: Array<Record<string, unknown>>, fallback = false) {
  return {
    config: { CHAIN_ID: 4663, NETWORK: "mainnet", PUBLIC_RPC_URL: "https://rpc.example" },
    deployment: { contracts: {}, markets: fallback ? [deploymentMarket(1, "QQQ"), deploymentMarket(8, "QQQ3")] : [] },
    sql: async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("from markets order by id")) return marketRows;
      if (query.includes("from market_launch")) return launchRows;
      return [];
    },
  } as unknown as ApiDependencies;
}

test("runtime config filters market-launch overrides while preserving default launches", async () => {
  const result = await runtimeConfigResponse(depsFor([
    { id: 1, symbol: "NVDA", token: "0x1", stock: "0x2" },
    { id: 8, symbol: "SPCX", token: "0x3", stock: "0x4" },
  ], [
    { symbol: "NVDA", launched: false },
    { symbol: "SPCX", launched: true },
  ]));
  expect(result.markets.map((market) => market.symbol)).toEqual(["SPCX"]);
});

test("runtime config applies the launch gate to its deployment fallback", async () => {
  const result = await runtimeConfigResponse(depsFor([], [
    { symbol: "QQQ", launched: false },
    { symbol: "QQQ3", launched: true },
  ], true));
  expect(result.markets.map((market) => market.symbol)).toEqual(["QQQ3"]);
});
