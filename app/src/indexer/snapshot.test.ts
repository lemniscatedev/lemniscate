import { describe, expect, test } from "bun:test";
import type { ServiceClients } from "../chain/clients";
import { ADDR, b32, testDeployment } from "./test-support";
import { createRpcSnapshotReader } from "./snapshot";

const WAD = 10n ** 18n;

interface Call { address: string; functionName: string; args?: readonly unknown[] }

/** A viem-shaped client whose multicall answers from a script, recording every batch. */
function fakeClients(answer: (call: Call) => unknown) {
  const batches: { size: number; blockNumber: bigint }[] = [];
  const stateClient = {
    multicall: async ({ contracts, blockNumber }: { contracts: Call[]; allowFailure: boolean; blockNumber: bigint }) => {
      batches.push({ size: contracts.length, blockNumber });
      return contracts.map((call) => {
        try {
          return { status: "success", result: answer(call) };
        } catch {
          return { status: "failure", error: new Error("reverted") };
        }
      });
    },
  };
  return { clients: { stateClient } as unknown as ServiceClients, batches };
}

describe("snapshot reader", () => {
  test("reads the pool in the units the interfaces document", async () => {
    const { clients, batches } = fakeClients((call) => {
      switch (call.functionName) {
        case "balanceOf": return call.args?.[0] === ADDR.pool ? 1_500_000_000n : 75_000_000n;
        case "hedgeEquity": return [250_000_000n, 1_790_000_000n];
        case "totalLiability": return 400n * WAD;
        case "nav": return -5n * WAD;
        case "navPerShare": return 1_050_000_000_000_000_000n;
        default: throw new Error(call.functionName);
      }
    });
    const reader = createRpcSnapshotReader(clients, testDeployment());
    const pool = await reader.readPool(77n);
    expect(pool).toEqual({
      usdgBalance: 1_500_000_000n, hedgeEquity: 250_000_000n, liabilityWad: 400n * WAD, navWad: -5n * WAD,
      navPerShareWad: 1_050_000_000_000_000_000n, reserveUsdg: 75_000_000n,
    });
    expect(batches).toEqual([{ size: 9, blockNumber: 77n }]); // + navLiability(false/true) and guards (optional reads)
  });

  test("a core pool read that fails fails the snapshot instead of storing a guess", async () => {
    const { clients } = fakeClients((call) => {
      if (call.functionName === "nav") throw new Error("revert");
      return [1n, 2n];
    });
    await expect(createRpcSnapshotReader(clients, testDeployment()).readPool(1n)).rejects.toThrow(/pool.nav/);
  });

  test("stocks: price, both vol speeds and net greeks; a missing vol post is undefined, not an error", async () => {
    const { clients } = fakeClients((call) => {
      if (call.functionName === "read" && call.address === ADDR.priceGuard) {
        return { s: 120n * WAD, session: 1, fresh: true, buysPaused: false, updatedAt: 1_790_000_000n };
      }
      if (call.functionName === "read" && call.address === ADDR.volOracle) {
        if (call.args?.[1] === 1) throw new Error("no post");
        return { sigmaBps: 5200n, stale: true };
      }
      if (call.functionName === "netGreeks") return [-2n * WAD, WAD / 10n, 5n * WAD];
      throw new Error(call.functionName);
    });
    const [nvda] = await createRpcSnapshotReader(clients, testDeployment()).readStocks([ADDR.nvda], 10n);
    expect(nvda).toMatchObject({
      stock: ADDR.nvda, spotWad: 120n * WAD, session: 1, fresh: true, buysPaused: false, updatedAt: 1_790_000_000n,
      volDaily: { sigmaBps: 5200, stale: true }, volWeekly: undefined, deltaWad: -2n * WAD, gammaWad: WAD / 10n, vegaWad: 5n * WAD,
    });
  });

  test("series are read in chunks of at most 150 calls", async () => {
    const ids = Array.from({ length: 320 }, (_, i) => b32(i + 1));
    const { clients, batches } = fakeClients(() => ({ norm: WAD - 5n, lastAccrual: 1_790_000_000n, buyable: true, archived: false }));
    const readings = await createRpcSnapshotReader(clients, testDeployment()).readSeries(ids, 5n);
    expect(readings).toHaveLength(320);
    expect(readings[0]).toEqual({ id: b32(1), norm: WAD - 5n, lastAccrual: 1_790_000_000n, buyable: true, archived: false });
    expect(batches.map((batch) => batch.size)).toEqual([150, 150, 20]);
  });
});

describe("decision 30/31 trade-price state", () => {
  test("the pool reading carries engine.navLiability bounds and the hold and settle-delay guards (decision 36)", async () => {
    const { clients } = fakeClients((call) => {
      switch (call.functionName) {
        case "navLiability": return call.args?.[0] ? 410n * WAD : 395n * WAD;
        case "guards": return [1_000_000n, 1800, 604_800];
        case "hedgeEquity": return [0n, 0n];
        default: return 1n;
      }
    });
    const pool = await createRpcSnapshotReader(clients, testDeployment()).readPool(1n);
    expect(pool).toMatchObject({ navLiabilityLowWad: 395n * WAD, navLiabilityHighWad: 410n * WAD, holdSeconds: 1800, haltSettleDelaySeconds: 604_800 });
  });

  test("stocks also carry the trade TWAP, the ORC-4 settlement price and the halt latch; a failed read is 0", async () => {
    const { clients } = fakeClients((call) => {
      if (call.functionName === "read" && call.address === ADDR.priceGuard) return { s: 120n * WAD, session: 4, fresh: false, buysPaused: true, updatedAt: 1n };
      if (call.functionName === "read") return { sigmaBps: 5000n, stale: false };
      if (call.functionName === "netGreeks") return [0n, 0n, 0n];
      if (call.functionName === "tradeTwap") return 121n * WAD;
      if (call.functionName === "settlePrice") return 119n * WAD;
      if (call.functionName === "haltedSince") throw new Error("old guard");
      throw new Error(call.functionName);
    });
    const [nvda] = await createRpcSnapshotReader(clients, testDeployment()).readStocks([ADDR.nvda], 10n);
    expect(nvda).toMatchObject({ tradeTwapWad: 121n * WAD, settlePriceWad: 119n * WAD, haltedSince: 0n });
  });

  test("holds are read with engine.holdOf; a failed read is left out", async () => {
    const { clients } = fakeClients((call) => {
      if (call.functionName !== "holdOf") throw new Error(call.functionName);
      if (call.args?.[1] === ADDR.bob) throw new Error("revert");
      return { until: 1_790_000_600n, s: 118n * WAD };
    });
    const holds = await createRpcSnapshotReader(clients, testDeployment()).readHolds!([
      { seriesId: b32(1), account: ADDR.alice }, { seriesId: b32(1), account: ADDR.bob },
    ], 3n);
    expect(holds).toEqual([{ seriesId: b32(1), account: ADDR.alice, until: 1_790_000_600n, sWad: 118n * WAD }]);
  });
});
