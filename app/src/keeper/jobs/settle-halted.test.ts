import { describe, expect, test } from "bun:test";
import { A, FakeChain, WAD } from "../test-support";
import { createSettleHaltedJob } from "./settle-halted";

const halted = { s: 100n * WAD, session: 4, fresh: false, buysPaused: true, updatedAt: 1n };

describe("ORC-4 settleHalted keeper job (review F07/F21, decision 31)", () => {
  test("settles a stock HALTED for the settle delay, once, and reports the others with their settle time", async () => {
    const chain = new FakeChain();
    chain.prices.set(A.nvda, halted);
    chain.prices.set(A.spy, halted);
    chain.haltedSince.set(A.nvda, chain.nowSeconds - 8n * 86_400n); // past the 7-day delay
    chain.haltedSince.set(A.spy, chain.nowSeconds - 86_400n); // not yet
    const job = createSettleHaltedJob(chain.context());
    const first = await job();
    expect(chain.sent.filter((tx) => tx.name === "settleHalted").map((tx) => tx.args[0])).toEqual([A.nvda]);
    expect(first.settled).toEqual(["NVDA"]);
    expect(first.halted).toEqual([{ name: "SPY", since: new Date(Number(chain.nowSeconds - 86_400n) * 1000).toISOString(),
      settleableAt: new Date(Number(chain.nowSeconds + 6n * 86_400n) * 1000).toISOString() }]);
    // already settled: nothing more is sent
    await job();
    expect(chain.sent.filter((tx) => tx.name === "settleHalted").length).toBe(1);
  });

  test("sends nothing for live names, and a revert backs that stock off instead of retrying every run", async () => {
    const chain = new FakeChain();
    chain.prices.set(A.nvda, { ...halted, session: 0, fresh: true, buysPaused: false });
    const job = createSettleHaltedJob(chain.context());
    expect((await job()).settled).toEqual([]);
    expect(chain.sent).toEqual([]);
    chain.prices.set(A.spy, halted);
    chain.haltedSince.set(A.spy, chain.nowSeconds - 8n * 86_400n);
    chain.failing.add("settleHalted");
    await job();
    await job();
    expect(chain.sent.length).toBe(0);
    const attempts = (await job()).failed;
    expect(attempts).toEqual([]); // backing off: not even tried
  });
});
