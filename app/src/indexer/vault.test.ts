import { expect, test } from "bun:test";
import { handleVaultEvent } from "./handlers/vault";
import type { ChainEvent, IndexerContext } from "./types";

test("changing the global lock refreshes existing depositors without new account activity", async () => {
  const alice = "0x00000000000000000000000000000000000000a1";
  const bob = "0x00000000000000000000000000000000000000b2";
  const context = {
    tx: async () => [{ account: alice }, { account: bob }],
    vaultConfig: { lockSeconds: 86400 },
    touchedAccounts: new Set<string>(), kinds: new Set<string>(),
    snapshotNeeded: false, hasLemniscateEvents: false,
  } as unknown as IndexerContext;
  await handleVaultEvent(context, {
    source: "vault", eventName: "ParamsUpdated",
    args: {
      lockSeconds: 7200, cashBufferBps: 1000, hedgeRatioBps: 10000,
      rebalanceThresholdBps: 1000, maxHedgeSlippageBps: 100,
      minHedgeTradeUsdg: 2000000n, maxTotalDeposits: 1000000000n,
    },
  } as unknown as ChainEvent);
  expect(context.vaultConfig.lockSeconds).toBe(7200);
  expect(context.snapshotNeeded).toBe(true);
  expect([...context.touchedAccounts].sort()).toEqual([alice, bob]);
});
