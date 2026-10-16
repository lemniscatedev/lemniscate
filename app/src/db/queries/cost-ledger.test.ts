import { expect, test } from "bun:test";
import { fixed } from "../../lib/fixed";
import { addAtCost, emptyCostState, removeAtAverageCost } from "./cost-ledger";
import { VAULT_EVENT_LIMIT, vaultCostBasis, type VaultLedgerEvent } from "./vault-ledger";

const event = (kind: VaultLedgerEvent["kind"], shares: string, assets = "0", nav_per_share: string | null = null): VaultLedgerEvent => ({ kind, shares, assets, nav_per_share });

test("average cost removes proportional cost, clamps overdraw and clears rounding dust", () => {
  const state = emptyCostState();
  addAtCost(state, 3n, 10n);
  expect(removeAtAverageCost(state, 1n)).toBe(3n);
  expect(state.cost).toBe(7n);
  expect(removeAtAverageCost(state, 0n)).toBe(0n);
  expect(removeAtAverageCost(state, 5n)).toBe(7n);
  expect(state).toEqual(emptyCostState());
  expect(removeAtAverageCost(state, 1n)).toBe(0n);
});

test("deposit, partial withdrawal, then deposit retain the remaining average cost", () => {
  const rows = [event("deposit", "10", "10"), event("withdraw", "4", "4.4"), event("deposit", "5", "6")];
  expect(vaultCostBasis(rows, fixed("11"), fixed("13.2"))).toEqual({ costBasis: "12", change: "1.2", changePct: 10, historyComplete: true });
});

test("incoming shares use transfer-time NAV, outgoing shares remove average cost", () => {
  const rows = [event("deposit", "10", "10"), event("transfer_in", "10", "0", "2"), event("transfer_out", "5")];
  expect(vaultCostBasis(rows, fixed("15"), fixed("30"))).toEqual({ costBasis: "22.5", change: "7.5", changePct: 33.3333, historyComplete: true });
});

test("full exit and empty balance have zero remaining cost and no percent", () => {
  const rows = [event("deposit", "3", "10"), event("withdraw", "1"), event("withdraw", "2")];
  expect(vaultCostBasis(rows, 0n, 0n)).toEqual({ costBasis: "0", change: "0", changePct: null, historyComplete: true });
  expect(vaultCostBasis([], 0n, 0n).changePct).toBeNull();
});

test("missing transfer NAV, unknown shares and truncated ledgers disclose incomplete history", () => {
  expect(vaultCostBasis([event("transfer_in", "2")], fixed("2"), fixed("4")).historyComplete).toBe(false);
  expect(vaultCostBasis([], fixed("2"), fixed("4")).historyComplete).toBe(false);
  expect(vaultCostBasis([event("withdraw", "2")], 0n, 0n).historyComplete).toBe(false);
  const rows = Array.from({ length: VAULT_EVENT_LIMIT + 1 }, () => event("deposit", "1", "1"));
  const result = vaultCostBasis(rows, fixed(String(VAULT_EVENT_LIMIT + 1)), fixed("6000"));
  expect(result.costBasis).toBe(String(VAULT_EVENT_LIMIT));
  expect(result.historyComplete).toBe(false);
});

test("a loss remains signed, with null percentage only when there is no positive cost", () => {
  const result = vaultCostBasis([event("deposit", "10", "10")], fixed("10"), fixed("9"));
  expect(result.change).toBe("-1");
  expect(result.changePct).toBeCloseTo(-10, 3);
  expect(vaultCostBasis([event("deposit", "1", "0")], fixed("1"), fixed("1")).changePct).toBeNull();
});
