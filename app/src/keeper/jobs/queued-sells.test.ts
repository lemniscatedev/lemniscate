import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../../testing/db";
import { A, FakeChain } from "../test-support";
import { createQueuedSellsJob } from "./queued-sells";

const suite = testDatabaseUrl() ? describe : describe.skip;

suite("queued-sells keeper job", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = (await createTestDatabase("queued_sells"))!;
    await applyMigrations(db);
  });
  afterAll(async () => db.close());
  beforeEach(async () => {
    await db.sql`truncate queued_sells, series, norm_history`;
  });

  async function addSeries(id: string, vMark = 2) {
    await db.sql`insert into series (id, stock_token, is_call, speed, tau_s, strike, token, norm, last_accrual, listed_at, listed_block, listed_tx, listed_log)
      values (${id}, ${A.nvda}, true, 'DAILY', 86400, 100, ${"0x" + id.padStart(40, "0")}, 1, now(), now(), 1, '0x', 0)`;
    await db.sql`insert into norm_history (series_id, ts, tx_hash, log_index, block, norm, v_mark, payoff, session)
      values (${id}, now(), '0x', 0, 1, 1, ${vMark}, 0, 'REGULAR')`;
  }
  async function addTicket(ticket: number, seriesId: string, tokens = "5", queuedAt = "now()") {
    await db.sql.unsafe(`insert into queued_sells (ticket, series_id, seller, recipient, tokens, queued_at, queued_block, queued_tx, queued_log)
      values (${ticket}, '${seriesId}', '0xaa', '0xaa', ${tokens}, ${queuedAt}, 1, '0x', ${ticket})`);
  }
  /** A fake chain whose fills also close the ticket in the database, like the indexer would. */
  function harness(failing: number[] = []) {
    const chain = new FakeChain();
    for (const t of failing) chain.failing.add(`fillQueued:${t}`);
    const base = chain.tx();
    const tx = { submit: async (t: Parameters<typeof base.submit>[0]) => {
      const result = await base.submit(t);
      const sent = chain.sent[chain.sent.length - 1]!;
      if (sent.name === "fillQueued") await db.sql`update queued_sells set status = 'filled' where ticket = ${String(sent.args[0])}`;
      return result;
    } };
    return { chain, context: chain.context({ sql: db.sql, tx }, { KEEPER_QUEUED_DUST_USDG: 0.01, KEEPER_QUEUED_ALERT_MINUTES: 60 }) };
  }
  const fills = (chain: FakeChain) => chain.sent.filter((s) => s.name === "fillQueued").map((s) => Number(s.args[0]));

  test("fills every fillable ticket and sends nothing when the queue is empty", async () => {
    await addSeries("a");
    for (const t of [1, 2, 3]) await addTicket(t, "a");
    const { chain, context } = harness();
    const job = createQueuedSellsJob(context);
    expect((await job()).filled).toBe(3);
    expect(fills(chain).sort()).toEqual([1, 2, 3]);
    expect((await job()).attempted).toBe(0);
    expect(fills(chain).length).toBe(3);
  });

  test("one ticket that reverts does not block the others, and is not retried inside the back-off", async () => {
    await addSeries("a"); await addSeries("b"); await addSeries("c");
    await addTicket(1, "a"); await addTicket(2, "b"); await addTicket(3, "c");
    const { chain, context } = harness([2]);
    const job = createQueuedSellsJob(context);
    expect(await job()).toMatchObject({ filled: 2, notFillable: 1 });
    chain.sent.length = 0;
    expect((await job()).attempted).toBe(0); // ticket 2 is backing off, excluded in SQL
    chain.nowSeconds += 700n;
    chain.failing.delete("fillQueued:2");
    expect((await job()).filled).toBe(1);
  });

  test("F29/F36: 300 stuck tickets on a halted name do not starve a later ticket on another name", async () => {
    await addSeries("halted"); await addSeries("live");
    for (let t = 1; t <= 300; t++) await addTicket(t, "halted");
    await addTicket(301, "live");
    const { chain, context } = harness(Array.from({ length: 300 }, (_, i) => i + 1));
    const job = createQueuedSellsJob(context, 25);
    const first = await job();
    expect(fills(chain)).toContain(301); // round-robin: the live name is served on the very first pass
    expect(first.filled).toBe(1);
    expect(first.attempted).toBeLessThanOrEqual(2); // one revert on the halted name ends its turn for the pass
  });

  test("F29/F36: tickets in back-off are excluded in SQL, so they cannot fill the read window", async () => {
    await addSeries("halted"); await addSeries("live");
    for (let t = 1; t <= 220; t++) await addTicket(t, "halted");
    for (let t = 221; t <= 224; t++) await addTicket(t, "live");
    const { chain, context } = harness(Array.from({ length: 220 }, (_, i) => i + 1));
    const job = createQueuedSellsJob(context, 5);
    for (let pass = 0; pass < 6; pass++) await job();
    expect(fills(chain).sort()).toEqual([221, 222, 223, 224]);
  });

  test("S-3 permanent hold: a name that stays HALTED never stops the others, pass after pass", async () => {
    await addSeries("halted"); await addSeries("live");
    for (let t = 1; t <= 50; t++) await addTicket(t, "halted");
    const { chain, context } = harness(Array.from({ length: 50 }, (_, i) => i + 1));
    const job = createQueuedSellsJob(context, 10);
    for (let pass = 0; pass < 3; pass++) await job();
    await addTicket(51, "live");
    await job();
    expect(fills(chain)).toEqual([51]);
  });

  test("dust tickets are filled last, at most one per pass, and never ahead of real ones", async () => {
    await addSeries("a", 2);
    for (let t = 1; t <= 5; t++) await addTicket(t, "a", "0.000000000000000001"); // 1 wei: worth ~0
    await addTicket(6, "a", "5");
    await addTicket(7, "a", "5");
    const { chain, context } = harness();
    const job = createQueuedSellsJob(context, 25);
    const first = await job();
    expect(fills(chain).slice(0, 2).sort()).toEqual([6, 7]); // real first
    expect(first.dust).toBe(1);
    expect(fills(chain).length).toBe(3); // 2 real + exactly 1 dust
    await job(); await job(); await job(); await job();
    expect(fills(chain).length).toBe(7); // the dust is still served, one per pass: sells stay always possible
  });

  test("a pass is bounded by maxPerPass", async () => {
    await addSeries("a"); await addSeries("b");
    for (let t = 1; t <= 10; t++) await addTicket(t, t % 2 ? "a" : "b");
    const { chain, context } = harness();
    const first = await createQueuedSellsJob(context, 4)();
    expect(first.attempted).toBe(4);
    expect(fills(chain).length).toBe(4);
  });

  test("a held nonce stops the pass instead of burning every ticket", async () => {
    await addSeries("a");
    await addTicket(1, "a"); await addTicket(2, "a");
    const { context } = harness();
    const tx = { submit: async () => { throw new Error("nonce 7 is held"); } };
    await expect(createQueuedSellsJob({ ...context, tx } as never)()).rejects.toThrow("held");
  });

  test("an old open ticket is reported so an escrowed seller is not left silently paying funding", async () => {
    await addSeries("a");
    await addTicket(1, "a", "5", "now() - interval '3 hours'");
    const { chain, context } = harness([1]);
    const result = await createQueuedSellsJob(context)();
    expect(Number(result.oldestOpenMinutes)).toBeGreaterThanOrEqual(179);
    void chain;
  });
});
