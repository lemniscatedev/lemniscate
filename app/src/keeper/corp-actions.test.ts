import { expect, test } from "bun:test";
import { normalizeCorporateActions, processDate } from "./jobs/corp-actions";

test("Robinhood envelopes, date objects and chain-specific deployments are normalized", () => {
  const stock = "0x0000000000000000000000000000000000000001";
  const actions = normalizeCorporateActions({ corpActions: [{
    id: "example", tokenSymbol: "NVDA", type: "CORPORATE_ACTION_TYPE_CASH_DIVIDEND",
    status: "CORPORATE_ACTION_STATUS_IN_PROGRESS", processDate: { year: 2026, month: 10, day: 8 },
    deployments: [{ contractAddress: stock, chainId: 4663 }], details: { cashDividend: { rate: "0.01" } },
  }] }, [{ symbol: "NVDA", stock }]);
  expect(actions[0]?.processDate).toBe("2026-10-08");
  expect(actions[0]?.status).toBe("in_progress");
  expect(actions[0]?.kind).toBe("cash_dividend");
  expect(actions[0]?.effectiveAt).toBeNull();
  expect(processDate({ year: 2026, month: 2, day: 30 })).toBeNull();
  expect(processDate(null)).toBeNull();
});
