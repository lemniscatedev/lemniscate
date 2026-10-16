import { expect, test } from "bun:test";
import { transferLedger, type Transfer } from "./reconcile";
import type { Address, Hex } from "viem";

const zero = ("0x" + "0".repeat(40)) as Address;
const alice = ("0x" + "1".repeat(40)) as Address;
const bob = ("0x" + "2".repeat(40)) as Address;
const log = (block: number, from: Address, to: Address, value: bigint): Transfer => ({
  transactionHash: ("0x" + block.toString(16).padStart(64, "0")) as Hex,
  logIndex: 0, blockNumber: BigInt(block), from, to, value,
});

test("reconciliation reconstructs mint, transfer and burn at the exact ingestion boundary", () => {
  const events = [log(2, alice, bob, 3n), log(1, zero, alice, 10n), log(3, bob, zero, 1n)];
  const result = transferLedger(events);
  expect(result.balances.get(alice)).toBe(7n);
  expect(result.balances.get(bob)).toBe(2n);
  expect(result.ordered.map((x) => x.blockNumber)).toEqual([1n, 2n, 3n]);
  expect([...transferLedger(events).balances]).toEqual([...result.balances]);
});

test("reconciliation refuses duplicate or truncated transfer history", () => {
  const first = log(1, zero, alice, 10n);
  expect(() => transferLedger([first, first])).toThrow("Duplicate transfer log");
  expect(() => transferLedger([log(2, alice, bob, 3n)])).toThrow("history starts after");
});

test("zero-value and self transfers preserve the reconstructed balance", () => {
  const result = transferLedger([log(1, zero, alice, 10n), log(2, alice, alice, 3n), log(3, alice, bob, 0n)]);
  expect(result.balances.get(alice)).toBe(10n);
  expect(result.balances.get(bob)).toBe(0n);
  expect(result.balances.has(zero)).toBe(false);
});
