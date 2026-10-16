import { describe, expect, test } from "bun:test";
import { toEventSelector, type Address, type Hex } from "viem";
import type { Deployment } from "../chain/deployment";
import { decodeChainLog, type EventAddressMaps } from "./events";

describe("stock pause event ingestion", () => {
  const stock: Address = "0x0000000000000000000000000000000000000010";
  const maps: EventAddressMaps = {
    deployment: { contracts: { engine: "0x01", vault: "0x02", marketHours: "0x03" } } as unknown as Deployment,
    marketById: new Map(), tokenToMarket: new Map(), aggregatorToMarket: new Map(),
    stockToMarket: new Map([[stock, 5]]),
  };
  for (const name of ["OraclePaused", "OracleUnpaused", "Paused", "Unpaused"]) {
    test(`${name} maps its stock address even though it has no arguments`, () => {
      const event = decodeChainLog({
        address: stock, blockNumber: 100n, transactionHash: `0x${"12".repeat(32)}` as Hex,
        logIndex: 0, data: "0x", topics: [toEventSelector(`${name}()`)],
      }, maps, new Date("2026-09-30T00:00:00Z"));
      expect(event?.eventName).toBe(name);
      expect(event?.marketId).toBe(5);
      expect(event?.args).toEqual({});
    });
  }
});
