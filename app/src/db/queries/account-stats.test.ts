import { expect, test } from "bun:test";
import { fixed } from "../../lib/fixed";
import type { ApiDependencies } from "../../api/types";
import { accountStats, summarizeFills } from "./account-stats";
import type { RealizedFill } from "./power-ledger";

const address = "0x1111111111111111111111111111111111111111";
const symbols = new Map([[1, "NVDA"], [2, "TSLA"]]);

function fill(marketId: number, realized: string, n: number): RealizedFill {
  const value = fixed(realized);
  return {
    marketId, txHash: `0x${String(n).padStart(64, "0")}`, logIndex: 0, ts: `2026-10-0${n}T00:00:00.000Z`,
    quantity: fixed("1"), proceeds: fixed("10") + value, costRemoved: fixed("10"), realized: value,
  };
}

test("no fills give zero realized and no win rate", () => {
  const summary = summarizeFills([], symbols);
  expect(summary).toMatchObject({ realizedPnlUsd: "0", closedTrades: 0, winningTrades: 0, winRatePct: null, bestTrade: null, worstTrade: null });
  expect(summary.byMarket.size).toBe(0);
});

test("two losses rank the smaller loss as best", () => {
  const summary = summarizeFills([fill(1, "-1", 1), fill(1, "-3", 2)], symbols);
  expect(summary.winRatePct).toBe(0);
  expect(summary.realizedPnlUsd).toBe("-4");
  expect(summary.worstTrade).toEqual({ symbol: "NVDA", realizedPnlUsd: "-3", ts: "2026-10-02T00:00:00.000Z", txHash: fill(1, "0", 2).txHash });
  expect(summary.bestTrade).toMatchObject({ symbol: "NVDA", realizedPnlUsd: "-1" });
});

test("mixed results split realized P&L by market", () => {
  const summary = summarizeFills([fill(1, "5", 1), fill(2, "-2", 2)], symbols);
  expect(summary).toMatchObject({ realizedPnlUsd: "3", closedTrades: 2, winningTrades: 1, winRatePct: 50 });
  expect(summary.bestTrade?.symbol).toBe("NVDA");
  expect(summary.worstTrade?.symbol).toBe("TSLA");
  expect([...summary.byMarket]).toEqual([["NVDA", fixed("5")], ["TSLA", fixed("-2")]]);
});

test("equal results keep the earliest close", () => {
  const summary = summarizeFills([fill(1, "2", 1), fill(2, "2", 2)], symbols);
  expect(summary.bestTrade?.symbol).toBe("NVDA");
  expect(summary.worstTrade?.symbol).toBe("NVDA");
});

test("a wallet without history returns zeros and nulls", async () => {
  const queries: string[] = [];
  const values: unknown[][] = [];
  const deps = {
    config: { NETWORK: "mainnet" },
    sql: async (strings: TemplateStringsArray, ...args: unknown[]) => { queries.push(strings.join("?")); values.push(args); return []; },
  } as unknown as ApiDependencies;
  const stats = await accountStats(deps, address);
  expect(stats).toMatchObject({ volumeUsd: "0", feesPaidUsd: "0", trades: 0, firstTradeAt: null, lastTradeAt: null,
    realizedPnlUsd: "0", winRatePct: null, bestTrade: null, markets: [], historyComplete: true });
  expect(queries.some((q) => q.includes("active_days"))).toBe(true);
  expect(values.filter((v) => v.includes(address))).toHaveLength(3);
});

test("markets merge realized P&L and include markets closed from received tokens", async () => {
  const other = "0x2222222222222222222222222222222222222222";
  const deps = {
    sql: async (strings: TemplateStringsArray) => {
      const q = strings.join("?");
      if (q.includes("active_days")) return [{ trades: 2, buys: 1, sells: 1, volume: "32", fees: "0.1", first_at: new Date("2026-10-01T00:00:00Z"), last_at: new Date("2026-10-02T00:00:00Z"), markets: 1, active_days: 2 }];
      if (q.includes("group by m.symbol")) return [{ symbol: "NVDA", volume: "32", trades: 2 }];
      if (q.includes("from markets order by id")) return [{ id: 1, symbol: "NVDA" }, { id: 2, symbol: "TSLA" }];
      if (q.includes("from trades")) return [
        { event_kind: "trade", market_id: 1, side: "buy", from_addr: address, to_addr: address, quantity: "10", usdg: "20", price: "2", block: 1, log_index: 0, ts: "2026-10-01T00:00:00Z", tx_hash: "0xa" },
        { event_kind: "trade", market_id: 1, side: "sell", from_addr: address, to_addr: address, quantity: "4", usdg: "12", price: "3", block: 2, log_index: 0, ts: "2026-10-02T00:00:00Z", tx_hash: "0xb" },
        { event_kind: "transfer", market_id: 2, side: null, from_addr: other, to_addr: address, quantity: "1", usdg: "0", price: "5", block: 3, log_index: 0, ts: "2026-10-03T00:00:00Z", tx_hash: "0xc" },
        { event_kind: "trade", market_id: 2, side: "sell", from_addr: address, to_addr: address, quantity: "1", usdg: "4", price: "4", block: 4, log_index: 0, ts: "2026-10-04T00:00:00Z", tx_hash: "0xd" },
      ];
      return [];
    },
  } as unknown as ApiDependencies;
  const stats = await accountStats(deps, address);
  expect(stats).toMatchObject({ trades: 2, firstTradeAt: "2026-10-01T00:00:00.000Z", realizedPnlUsd: "3", closedTrades: 2, winRatePct: 50 });
  expect(stats.bestTrade).toMatchObject({ symbol: "NVDA", realizedPnlUsd: "4", txHash: "0xb" });
  expect(stats.worstTrade).toMatchObject({ symbol: "TSLA", realizedPnlUsd: "-1", txHash: "0xd" });
  expect(stats.markets).toEqual([
    { symbol: "NVDA", volumeUsd: "32", trades: 2, realizedPnlUsd: "4" },
    { symbol: "TSLA", volumeUsd: "0", trades: 0, realizedPnlUsd: "-1" },
  ]);
});
