import { expect, test } from "bun:test";
import { fixed } from "../../lib/fixed";
import type { ApiDependencies } from "../../api/types";
import { PORTFOLIO_EVENT_LIMIT, powerLedgerEvents, replayPowerLedger, type PowerLedgerEvent } from "./power-ledger";

const address = "0x1111111111111111111111111111111111111111";
const other = "0x2222222222222222222222222222222222222222";
const hash = (n: number) => `0x${String(n).padStart(64, "0")}`;

const events = [
  { event_kind: "trade", market_id: 1, side: "buy", from_addr: address, to_addr: address, quantity: "10", usdg: "20", price: "2", block: 1, log_index: 0, ts: "2026-10-01T00:00:00Z", tx_hash: hash(1) },
  { event_kind: "trade", market_id: 1, side: "sell", from_addr: address, to_addr: address, quantity: "4", usdg: "12", price: "3", block: 2, log_index: 3, ts: new Date("2026-10-02T00:00:00Z"), tx_hash: hash(2) },
  { event_kind: "transfer", market_id: 1, side: null, from_addr: other, to_addr: address, quantity: "2", usdg: "0", price: "4", block: 3, log_index: 0, ts: "2026-10-03T00:00:00Z", tx_hash: hash(3) },
  { event_kind: "transfer", market_id: 1, side: null, from_addr: address, to_addr: other, quantity: "1", usdg: "0", price: "5", block: 4, log_index: 0, ts: "2026-10-04T00:00:00Z", tx_hash: hash(4) },
] as PowerLedgerEvent[];

test("replay records one fill per sell and keeps average-cost state", () => {
  const { costs, fills } = replayPowerLedger(events, address);
  expect(fills).toEqual([{
    marketId: 1, txHash: hash(2), logIndex: 3, ts: "2026-10-02T00:00:00.000Z",
    quantity: fixed("4"), proceeds: fixed("12"), costRemoved: fixed("8"), realized: fixed("4"),
  }]);
  expect(costs.get(1)).toEqual({ quantity: fixed("7"), cost: fixed("17.5"), realized: fixed("4") });
});

test("replay ignores sells by other wallets", () => {
  const { fills } = replayPowerLedger([{ ...events[1]!, from_addr: other }], address);
  expect(fills).toEqual([]);
});

test("ledger query selects timestamps and hashes and trims the over-fetch", async () => {
  const queries: string[] = [];
  const rows = Array.from({ length: PORTFOLIO_EVENT_LIMIT + 1 }, (_, i) => ({ ...events[0]!, block: i }));
  const deps = {
    sql: async (strings: TemplateStringsArray) => { queries.push(strings.join("?")); return rows; },
  } as unknown as ApiDependencies;
  const result = await powerLedgerEvents(deps, address);
  expect(result.historyComplete).toBe(false);
  expect(result.events).toHaveLength(PORTFOLIO_EVENT_LIMIT);
  expect(result.events[0]!.block).toBe(1);
  expect(queries[0]!.match(/log_index, ts, tx_hash/g)).toHaveLength(3);
});

test("ledger query reports a complete history when under the cap", async () => {
  const deps = { sql: async () => [] } as unknown as ApiDependencies;
  expect(await powerLedgerEvents(deps, address)).toEqual({ events: [], historyComplete: true });
});
