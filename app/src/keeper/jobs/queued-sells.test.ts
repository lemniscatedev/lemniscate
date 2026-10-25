import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { encodeErrorResult } from "viem";
import { OptionEngineAbi } from "../../abi";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../../testing/db";
import { A, FakeChain } from "../test-support";
import { createQueuedSellsJob } from "./queued-sells";

const suite = testDatabaseUrl() ? describe : describe.skip;

/** What a geth or Nitro node returns for a custom-error revert once viem has wrapped it: no name and no selector in any
 * message (viem says "Execution reverted for an unknown reason"), the error's data on the cause. */
function nitroRevert(errorName: "Slippage" | "QueueNotFillable", args: readonly bigint[]): Error {
  const data = encodeErrorResult({ abi: OptionEngineAbi, errorName, args: args as never });
  const rpc = Object.assign(new Error("execution reverted"), { code: 3, data });
  return Object.assign(new Error("Execution reverted for an unknown reason.\n\nDetails: execution reverted"), { name: "EstimateGasExecutionError", cause: rpc, shortMessage: "Execution reverted for an unknown reason." });
}

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
    expect(first.attempted).toBeLessThanOrEqual(25); // R14: a revert is no proof about the series; the pass is still bounded
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

  test("F22/F23: a ticket whose minProceeds is not met (Slippage) backs off alone; its series' other tickets still fill", async () => {
    await addSeries("a");
    await addTicket(1, "a"); await addTicket(2, "a"); await addTicket(3, "a");
    const { chain, context } = harness();
    const base = context.tx;
    let slipping = true;
    const tried: number[] = [];
    const tx = { submit: async (t: Parameters<typeof base.submit>[0]) => {
      const sent = chain.sent.length;
      const { decodeFunctionData } = await import("viem");
      const { OptionEngineAbi } = await import("../../abi");
      const ticket = Number((decodeFunctionData({ abi: OptionEngineAbi, data: t.data }).args as readonly unknown[])[0]);
      tried.push(ticket);
      if (ticket === 1 && slipping) throw nitroRevert("Slippage", [9n, 10n]);
      void sent;
      return base.submit(t);
    } };
    const job = createQueuedSellsJob({ ...context, tx } as never);
    const first = await job();
    expect(fills(chain).sort()).toEqual([2, 3]); // the series is not written off for the pass
    expect(first).toMatchObject({ filled: 2, belowMinimum: 1 });
    // no retry spam: inside its back-off the ticket is not sent again, and each further miss doubles the wait
    tried.length = 0;
    chain.nowSeconds += 5n * 60n;
    await job();
    expect(tried).toEqual([]);
    chain.nowSeconds += 6n * 60n; // 11 min after the first miss
    await job();
    expect(tried).toEqual([1]);
    tried.length = 0;
    chain.nowSeconds += 11n * 60n; // 11 min after the second miss: still backing off (20 min now)
    await job();
    expect(tried).toEqual([]);
    chain.nowSeconds += 10n * 60n;
    slipping = false;
    await job();
    expect(tried).toEqual([1]);
    expect(fills(chain)).toContain(1);
  });

  describe("R14 one seller's failing tickets cannot hold a series", () => {
    /** Tickets in `bad` revert the way a real node reports Slippage; the rest fill. Every ticket belongs to a seller. */
    function nitroHarness(bad: Set<number>) {
      const chain = new FakeChain();
      const base = chain.tx();
      const attempts: number[] = [];
      const tx = { submit: async (t: Parameters<typeof base.submit>[0]) => {
        const { decodeFunctionData } = await import("viem");
        const ticket = Number((decodeFunctionData({ abi: OptionEngineAbi, data: t.data }).args as readonly unknown[])[0]);
        attempts.push(ticket);
        if (bad.has(ticket)) throw nitroRevert("Slippage", [1n, 2n ** 128n - 1n]);
        const result = await base.submit(t);
        await db.sql`update queued_sells set status = 'filled' where ticket = ${String(ticket)}`;
        return result;
      } };
      return { chain, attempts, context: chain.context({ sql: db.sql, tx }, { KEEPER_QUEUED_DUST_USDG: 0.01, KEEPER_QUEUED_ALERT_MINUTES: 60 }) };
    }
    const addFor = async (ticket: number, seriesId: string, seller: string) => {
      await db.sql.unsafe(`insert into queued_sells (ticket, series_id, seller, recipient, tokens, queued_at, queued_block, queued_tx, queued_log)
        values (${ticket}, '${seriesId}', '${seller}', '${seller}', 5, now(), 1, '0x', ${ticket})`);
    };

    test("PoC: six attacker tickets at the head of a series, each reverting Slippage as a real node reports it, do not stop the honest tickets behind them", async () => {
      await addSeries("a");
      for (let t = 1; t <= 6; t++) await addFor(t, "a", "0xbad");
      for (let t = 7; t <= 9; t++) await addFor(t, "a", "0x600d");
      const { chain, context, attempts } = nitroHarness(new Set([1, 2, 3, 4, 5, 6]));
      const job = createQueuedSellsJob(context, 25);
      const first = await job();
      expect(first.belowMinimum).toBe(4); // the Slippage is recognised from the revert data; one seller gets 4 tickets of a series per pass
      expect(fills(chain).sort()).toEqual([7, 8, 9]); // and nothing is written off: the honest tickets fill on the first pass
      expect(attempts.filter((t) => t <= 6).length).toBe(4);
    });

    test("PROPERTY: any number of failing tickets from up to five sellers delays an honest ticket on the series by at most two passes", async () => {
      let seed = 777;
      const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
      for (let trial = 0; trial < 12; trial++) {
        await db.sql`truncate queued_sells, series, norm_history`;
        await addSeries("a");
        const sellers = 1 + rnd(5);
        const bad = new Set<number>();
        let next = 1;
        for (let s = 0; s < sellers; s++) {
          const count = 1 + rnd(120);
          for (let k = 0; k < count; k++) { await addFor(next, "a", `0xbad${s}`); bad.add(next); next++; }
        }
        const honest = next;
        await addFor(honest, "a", "0x600d");
        const { chain, context, attempts } = nitroHarness(bad);
        const job = createQueuedSellsJob(context, 25);
        let pass = 0;
        let perPassAttempts: number[] = [];
        while (!fills(chain).includes(honest) && pass < 12) {
          attempts.length = 0;
          await job();
          perPassAttempts = attempts.slice();
          pass++;
          chain.nowSeconds += 120n; // two minutes: inside the ten-minute back-off
          // a seller already flagged has at most two tickets tried on this series per pass
          if (pass > 1) expect(perPassAttempts.length).toBeLessThanOrEqual(25);
        }
        // pass 1 tries the first 25 tickets by rank; from then on each bad seller has at most two tickets per pass
        expect(fills(chain)).toContain(honest);
        expect(pass).toBeLessThanOrEqual(2); // up to five sellers use 4 slots each of a 25-ticket pass, the honest ticket is next
      }
    });

    test("a stock whose feed is HALTED (not settled) has its tickets left out of the pass altogether, and they do not take slots", async () => {
      await addSeries("halted"); await addSeries("live");
      for (let t = 1; t <= 40; t++) await addFor(t, "halted", "0x600d");
      await addFor(41, "live", "0x600d");
      const chain = new FakeChain();
      chain.prices.set(A.nvda, { s: 100n * 10n ** 18n, session: 4, fresh: false, buysPaused: true, updatedAt: 1n });
      const base = chain.tx();
      const tx = { submit: async (t: Parameters<typeof base.submit>[0]) => base.submit(t) };
      const context = chain.context({ sql: db.sql, tx }, {});
      // both series are on the same stock (nvda), so use a second stock for the live one
      await db.sql`update series set stock_token = ${A.spy} where id = 'live'`;
      chain.prices.set(A.spy, { s: 100n * 10n ** 18n, session: 0, fresh: true, buysPaused: false, updatedAt: 1n });
      const result = await createQueuedSellsJob(context, 5)();
      expect(result.attempted).toBe(1);
      expect(fills(chain)).toEqual([41]);
    });
  });
});
