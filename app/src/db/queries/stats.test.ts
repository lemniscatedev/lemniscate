import { expect, test } from "bun:test";
import type { ApiDependencies } from "../../api/types";
import { aggregateStats } from "./stats";
import { TtlCache } from "../../api/cache";

test("stats default fees, traders and all-time totals when nothing has traded", async () => {
  const deps = {
    config: { NETWORK: "mainnet" },
    sql: async (strings: TemplateStringsArray) => {
      const query = strings.join("?");
      if (query.includes("from markets")) return [];
      if (query.includes("vault_ticks")) return [];
      if (query.includes("traders_all")) return [{}];
      return [{ trades_24h: 0 }];
    },
  } as unknown as ApiDependencies;
  const stats = await aggregateStats(deps);
  expect(stats).toMatchObject({
    openInterestUsd: "0", volume24hUsd: "0", trades24h: 0, tvlUsd: "0",
    fees24hUsd: "0", uniqueTraders24h: 0, volumeAllTimeUsd: "0", tradesAllTime: 0, tradersAllTime: 0,
    markets: [],
  });
});

test("aggregate totals include all markets while the public market list respects launch overrides", async () => {
  const now = new Date("2026-10-08T12:00:00Z");
  const sql = async (strings: TemplateStringsArray) => {
    const query = strings.join("?");
    if (query.includes("from markets m")) return [
      { id: 1, symbol: "NVDA", token: "0x1", stock: "0x2", config: { kind: 0 }, ts: now, spot: "10", index: "10", norm_factor: "1", price: "10", bid: "9", ask: "11", carry_wad: "0", regime: 0, buys_paused: false, liability: "5", hedge_units: "0", hedge_target: "0", oracle_updated_at: now, previous_price: "10", volume_24h: "7" },
      { id: 8, symbol: "SPCX", token: "0x3", stock: "0x4", config: { kind: 0 }, ts: now, spot: "10", index: "10", norm_factor: "1", price: "10", bid: "9", ask: "11", carry_wad: "0", regime: 0, buys_paused: false, liability: "7", hedge_units: "0", hedge_target: "0", oracle_updated_at: now, previous_price: "10", volume_24h: "11" },
    ];
    if (query.includes("from market_launch")) return [{ symbol: "NVDA", launched: false }, { symbol: "SPCX", launched: true }];
    if (query.includes("trades_24h")) return [{ trades_24h: 0 }];
    if (query.includes("coalesce(sum(fee)")) return [{ fees_24h: "0", traders_24h: 0, volume_all: "0", trades_all: 0, traders_all: 0 }];
    return [];
  };
  const stats = await aggregateStats({
    config: { NETWORK: "mainnet" }, sql, cache: new TtlCache(),
  } as unknown as ApiDependencies);
  expect(stats.markets.map((market) => market.symbol)).toEqual(["SPCX"]);
  expect(stats.openInterestUsd).toBe("12");
  expect(stats.volume24hUsd).toBe("18");
});
