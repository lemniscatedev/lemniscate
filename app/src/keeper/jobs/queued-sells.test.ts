import { describe, expect, test } from "bun:test";
import { A, FakeChain } from "../test-support";
import { createQueuedSellsJob } from "./queued-sells";

function chainWithTickets(tickets: string[], failing: string[] = []) {
  const chain = new FakeChain();
  const open = new Set(tickets);
  for (const t of failing) chain.failing.add(`fillQueued:${t}`);
  const sql = Object.assign(async () => [...open].map((ticket) => ({ ticket })), { begin: async () => undefined });
  const base = chain.tx();
  const tx = { submit: async (t: Parameters<typeof base.submit>[0]) => {
    const result = await base.submit(t);
    const sent = chain.sent[chain.sent.length - 1]!;
    if (sent.name === "fillQueued") open.delete(String(sent.args[0]));
    return result;
  } };
  return { chain, open, context: chain.context({ sql, tx }) };
}

describe("queued-sells keeper job", () => {
  test("fills every fillable ticket and sends nothing when the queue is empty", async () => {
    const { chain, open, context } = chainWithTickets(["1", "2", "3"]);
    const job = createQueuedSellsJob(context);
    expect((await job()).filled).toBe(3);
    expect(chain.sent.map((s) => s.args[0])).toEqual([1n, 2n, 3n]);
    expect(open.size).toBe(0);
    expect((await job()).attempted).toBe(0);
    expect(chain.sent.length).toBe(3);
  });

  test("one ticket that reverts does not block the others, and is not retried inside the back-off", async () => {
    const { chain, context } = chainWithTickets(["1", "2", "3"], ["2"]);
    const job = createQueuedSellsJob(context);
    const first = await job();
    expect(first).toMatchObject({ filled: 2, notFillable: 1 });
    chain.sent.length = 0;
    const second = await job();
    expect(second.attempted).toBe(0); // ticket 2 is backing off
    chain.nowSeconds += 700n;
    chain.failing.delete("fillQueued:2");
    expect((await job()).filled).toBe(1);
  });

  test("a pass is bounded, and stuck tickets cannot starve fillable ones behind them", async () => {
    const tickets = Array.from({ length: 10 }, (_, i) => String(i + 1));
    const { chain, context } = chainWithTickets(tickets, ["1", "2", "3"]);
    const job = createQueuedSellsJob(context, 4);
    const first = await job();
    expect(first.attempted).toBe(4);
    expect(first.filled).toBe(1); // tickets 1-3 fail, 4 fills
    const second = await job();
    expect(second.filled).toBe(4); // 5-8, the stuck ones are skipped
    expect(chain.sent.filter((s) => s.name === "fillQueued").length).toBe(5);
  });

  test("a held nonce stops the pass instead of burning every ticket", async () => {
    const { chain, context } = chainWithTickets(["1", "2"]);
    chain.failing.add("fillQueued");
    // the fake tx throws a plain revert; a held nonce error is rethrown
    const tx = { submit: async () => { throw new Error("nonce 7 is held"); } };
    await expect(createQueuedSellsJob({ ...context, tx } as never)()).rejects.toThrow("held");
    void A;
  });
});
