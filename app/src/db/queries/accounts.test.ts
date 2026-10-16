import { expect, test } from "bun:test";
import type { ApiDependencies } from "../../api/types";
import { accountPortfolio } from "./accounts";

const address = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";

test("power portfolio fixture retains pre-extraction values with deposits and transfers", async () => {
  const queries: string[] = [];
  const values: unknown[][] = [];
  const deps = {
    config: { NETWORK: "mainnet" },
    deployment: { contracts: { vault: "0xAbC" } },
    sql: async (strings: TemplateStringsArray, ...args: unknown[]) => {
      const q = strings.join("?"); queries.push(q); values.push(args);
      if (q.includes("from balances b join")) return [{ id: 1, symbol: "NVDA", token: "power", balance: "7" }];
      if (q.includes("from markets m left")) return [{ id: 1, price: "3", norm_factor: "1", carry_wad: "0" }];
      if (q.includes("from trades")) return [
        { event_kind: "trade", market_id: 1, side: "buy", from_addr: address, to_addr: address, quantity: "10", usdg: "20", price: "2" },
        { event_kind: "trade", market_id: 1, side: "sell", from_addr: address, to_addr: address, quantity: "4", usdg: "12", price: "3" },
        { event_kind: "transfer", market_id: 1, from_addr: other, to_addr: address, quantity: "2", price: "4" },
        { event_kind: "transfer", market_id: 1, from_addr: address, to_addr: other, quantity: "1", price: "5" },
      ];
      if (q.includes("from vault_events")) return [{ kind: "deposit", shares: "5", assets: "5", nav_per_share: null }];
      if (q.includes("from balances where")) return [{ balance: "5" }];
      if (q.includes("from vault_ticks")) return [{ nav_per_share: "1.1" }];
      return [];
    },
  } as unknown as ApiDependencies;
  const result = await accountPortfolio(deps, address.toUpperCase());
  // Baseline: cost20 -> sell4 removes8, realized4 -> transfer-in8 -> transfer-out2.5.
  expect(result.positions).toEqual([{ symbol: "NVDA", balance: "7", price: "3", value: "21", avgCost: "2.5", costBasis: "17.5", unrealizedPnl: "3.5", realizedPnl: "4" }]);
  expect(result.totals).toEqual({ powerValue: "21", unrealizedPnl: "3.5", realizedPnl: "4" });
  expect(result.historyComplete).toBe(true);
  expect(result.writerPool).toEqual({ shares: "5", value: "5.5", costBasis: "5", change: "0.5", changePct: 10, historyComplete: true, unlockTime: null, isDepositor: false });
  const i = queries.findIndex((q) => q.includes("from vault_events"));
  expect(queries[i]).toContain("vault_ticks.block <= transfers.block");
  expect(queries[i]).toContain("vault_ticks.ts <= transfers.ts");
  expect(queries[i]).toContain("from_addr <> to_addr");
  expect(values[i]).toContain("0xabc");
  expect(values[i]).toContain(5001);
});
