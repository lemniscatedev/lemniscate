import { expect, test } from "bun:test";
import type { ApiDependencies } from "../../api/types";
import { rankRows, traderRanking } from "./leaderboard";

const aa = "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const bb = "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const cc = "0xcccccccccccccccccccccccccccccccccccccccc";

test("volume ranking breaks equal volumes by address", () => {
  const rows = rankRows([
    { account: bb, volume: "10", trades: 1, markets: 1, top_market: "NVDA", last_trade_at: "2026-10-01T00:00:00Z" },
    { account: cc, volume: "25.5", trades: 1, markets: 1, top_market: "TSLA", last_trade_at: "2026-10-02T00:00:00Z" },
    { account: aa, volume: "10", trades: 4, markets: 2, top_market: null, last_trade_at: null },
  ], "volume");
  expect(rows.map((row) => [row.rank, row.address])).toEqual([[1, cc], [2, aa], [3, bb]]);
  expect(rows[0]).toEqual({ rank: 1, address: cc, volumeUsd: "25.5", trades: 1, markets: 1, topMarket: "TSLA", lastTradeAt: "2026-10-02T00:00:00.000Z" });
  expect(rows[1]).toMatchObject({ topMarket: null, lastTradeAt: "1970-01-01T00:00:00.000Z" });
});

test("volume ranking compares amounts exactly, not as text", () => {
  const rows = rankRows([
    { account: aa, volume: "9.999999999999999999", trades: 1 },
    { account: bb, volume: "10.000000000000000000", trades: 1 },
  ], "volume");
  expect(rows.map((row) => row.address)).toEqual([bb, aa]);
});

test("trade-count ranking breaks equal counts by volume", () => {
  const rows = rankRows([
    { account: aa, volume: "5", trades: 3 },
    { account: bb, volume: "50", trades: 3 },
    { account: cc, volume: "1", trades: 9 },
  ], "trades");
  expect(rows.map((row) => [row.rank, row.address])).toEqual([[1, cc], [2, bb], [3, aa]]);
});

test("ranking an empty list returns no rows", () => {
  expect(rankRows([], "volume")).toEqual([]);
  expect(rankRows([], "trades")).toEqual([]);
});

function depsFor(calls: Array<{ query: string; params: unknown[] }>, rows: unknown[] = []) {
  const sql = async () => [];
  Object.assign(sql, {
    unsafe: async (query: string, params: unknown[]) => {
      calls.push({ query, params });
      return rows;
    },
  });
  return { config: { NETWORK: "mainnet" }, sql } as unknown as ApiDependencies;
}

test("ranking query bounds 7D by a fixed lookback and sends only now", async () => {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const now = new Date("2026-10-07T12:00:00Z");
  await traderRanking(depsFor(calls), "7D", "volume", now);
  expect(calls).toHaveLength(1);
  expect(calls[0]!.query).toContain("interval '7 days'");
  expect(calls[0]!.query).toContain("group by t.account");
  expect(calls[0]!.params).toEqual([now.toISOString()]);
});

test("all-time ranking query has no lower bound", async () => {
  const calls: Array<{ query: string; params: unknown[] }> = [];
  const now = new Date("2026-10-07T12:00:00Z");
  await traderRanking(depsFor(calls), "ALL", "trades", now);
  expect(calls[0]!.query).not.toContain("interval");
  expect(calls[0]!.params).toEqual([now.toISOString()]);
});

test("ranking query ranks the returned rows", async () => {
  const rows = await traderRanking(depsFor([], [
    { account: aa, volume: "1", trades: 1, markets: 1, top_market: "NVDA", last_trade_at: new Date("2026-10-06T00:00:00Z") },
    { account: bb, volume: "2", trades: 1, markets: 1, top_market: "NVDA", last_trade_at: new Date("2026-10-06T00:00:00Z") },
  ]), "30D", "volume", new Date("2026-10-07T12:00:00Z"));
  expect(rows.map((row) => [row.rank, row.address])).toEqual([[1, bb], [2, aa]]);
});
