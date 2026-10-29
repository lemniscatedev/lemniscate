// The payout commands end to end over a fake indexer history: export, check and record gates (skeptic M2, L1, L2).
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeAbiParameters, encodeEventTopics, erc20Abi, type Hex } from "viem";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import { writerRewards, type WriterRewardsConfig } from "../config/writer-rewards";
import { runPayout, type PayoutDeps, type PayoutReceipt } from "./writer-payout-run";

const suite = testDatabaseUrl() ? describe : describe.skip;
const DAY = 86_400_000;
const START = Date.parse("2027-01-04T00:00:00.000Z");
const W1_END = START + 7 * DAY;
const POOL = "0x0000000000000000000000000000000000001002";
const TOKEN = "0x00000000000000000000000000000000000001aa" as const;
const PAYER = "0x00000000000000000000000000000000000000f1";
const A = "0x000000000000000000000000000000000000000a";
const B = "0x000000000000000000000000000000000000000b";
const C = "0x000000000000000000000000000000000000000c";
const ZERO = "0x0000000000000000000000000000000000000000";
const config: WriterRewardsConfig = { ...writerRewards, tokenAddress: TOKEN, startAt: new Date(START).toISOString(), excludedWalletsReviewed: true };

let db: TestDatabase;
let out: string;
let code: Record<string, Hex> = {};
let n = 0;
const receipts = new Map<string, PayoutReceipt>();
const blockTimes = new Map<bigint, number>();
let nowMs = W1_END + 2 * 3_600_000;

const deps = (): PayoutDeps => ({
  sql: db.sql, pool: POOL, contracts: { pool: POOL }, chainId: 4663, config, repoRoot: join(import.meta.dir, "../../.."),
  getCode: async (address) => code[address] ?? "0x",
  getReceipt: async (hash) => receipts.get(hash) ?? Promise.reject(new Error("unknown tx")),
  getBlockTime: async (block) => blockTimes.get(block)!,
  now: () => new Date(nowMs),
});
const run = (...args: string[]) => runPayout(args, deps());
const indexedThrough = async (ms: number) => {
  await db.sql`DELETE FROM pool_nav`;
  await db.sql`INSERT INTO pool_nav (ts, block, usdg, hedge_equity, option_liability, reserve, nav, nav_per_share)
    VALUES (${new Date(ms).toISOString()}, 999, 100000, 0, 0, 0, 100000, 1)`;
};
async function deposit(account: string, usdg: number, ms: number) {
  n += 1;
  await db.sql`INSERT INTO pool_events (tx_hash, log_index, block, ts, kind, account, sender, receiver, assets, shares)
    VALUES (${`0xd${n}`}, 1, ${100 + n}, ${new Date(ms).toISOString()}, 'deposit', ${account}, ${account}, ${account}, ${usdg}, ${usdg})`;
}
/** A receipt that pays exactly the saved batch of `week`, sent by `from` in a block mined at `minedMs`. */
function payReceipt(hash: string, week: number, from = PAYER, minedMs = nowMs + 60_000): void {
  const batch = JSON.parse(readFileSync(join(out, `week-${week}.safe-batch.json`), "utf8")) as { transactions: { data: Hex }[] };
  const logs = batch.transactions.map((tx) => {
    const to = `0x${tx.data.slice(34, 74)}` as Hex;
    const value = BigInt(`0x${tx.data.slice(74)}`);
    return {
      address: TOKEN,
      topics: encodeEventTopics({ abi: erc20Abi, eventName: "Transfer", args: { from: PAYER as Hex, to } }) as Hex[],
      data: encodeAbiParameters([{ type: "uint256" }], [value]),
    };
  });
  const block = BigInt(5_000 + receipts.size);
  blockTimes.set(block, Math.floor(minedMs / 1_000));
  receipts.set(hash, { status: "success", from, blockNumber: block, logs });
}
const hash = (k: number) => `0x${k.toString(16).padStart(64, "0")}`;

suite("weekly payout export, check and record (fake indexer history)", () => {
  beforeAll(async () => {
    db = (await createTestDatabase("payoutrun"))!;
    await applyMigrations(db);
    out = mkdtempSync(join(tmpdir(), "lmns-payout-"));
    await deposit(A, 20_000, START - DAY);
    await deposit(B, 30_000, START);
    await deposit(C, 5_000, START + DAY);
    await deposit(writerRewards.projectWallets.owner!.toLowerCase(), 100_000, START);
    // a transfer IN never counts; the receiver's deposit stays as it was
    await db.sql`INSERT INTO transfers (tx_hash, log_index, block, ts, series_id, token, from_addr, to_addr, amount)
      VALUES ('0xmint', 0, 90, ${new Date(START).toISOString()}, NULL, ${POOL}, ${ZERO}, ${A}, 0)`;
  });
  afterAll(async () => db.close());

  test("L2: export waits until the indexer has read an hour past the week's end", async () => {
    await indexedThrough(W1_END + 30 * 60_000);
    const early = await run("export", "--week", "1", "--out", out, "--from", PAYER);
    expect(early.code).toBe(1);
    expect(early.out.join("\n")).toContain("an hour after the week ends");
  });

  test("export writes the unsigned files, records contract wallets found now, and tells the owner to run check before signing", async () => {
    await indexedThrough(W1_END + 61 * 60_000);
    const result = await run("export", "--week", "1", "--out", out, "--from", PAYER);
    expect(result.code).toBe(0);
    expect(result.out.join("\n")).toContain("Right before signing, run: writer-payout.ts check --week 1");
    const summary = JSON.parse(readFileSync(join(out, "week-1.summary.json"), "utf8"));
    expect(summary.from).toBe(PAYER);
    expect(summary.excluded.map((row: { reason: string }) => row.reason)).toContain("project wallet (owner)");
    expect(BigInt(summary.allocatedUnits) + BigInt(summary.unallocatedUnits)).toBe(1_000_000n * 10n ** 18n);
  });

  test("a second export of the same week is refused (file collision)", async () => {
    const again = await run("export", "--week", "1", "--out", out, "--from", PAYER);
    expect(again.code).toBe(1);
    expect(again.out.join("\n")).toContain("already exported");
  });

  test("week N+1 cannot be exported until week N is recorded", async () => {
    await indexedThrough(W1_END + 7 * DAY + 2 * 3_600_000);
    const blocked = await run("export", "--week", "2", "--out", out, "--from", PAYER);
    expect(blocked.code).toBe(1);
    expect(blocked.out.join("\n")).toContain("Week 1 is not recorded yet");
  });

  test("M2: a wallet that becomes a contract AFTER the export changes neither check nor record", async () => {
    code = { [C]: "0x6080604052" }; // C deploys code at its address after the export
    const check = await run("check", "--week", "1", "--out", out);
    expect(check.code).toBe(0);
    expect(check.out.join("\n")).toContain("recomputes to the saved export");
    nowMs = W1_END + 3 * 3_600_000;
    payReceipt(hash(1), 1);
    const recorded = await run("record", "--week", "1", "--out", out, "--tx", hash(1));
    expect(recorded.out.join("\n")).toContain("Week 1 recorded");
    expect(recorded.code).toBe(0);
  });

  test("check refuses a tampered export", async () => {
    const path = join(out, "week-1.csv");
    const original = readFileSync(path, "utf8");
    writeFileSync(path, original.replace(/,(\d{20,})(,)/, (_, units, comma) => `,${BigInt(units) + 1n}${comma}`));
    const tampered = await run("check", "--week", "1", "--out", out);
    expect(tampered.code).toBe(1);
    expect(tampered.out.join("\n")).toContain("disagree");
    writeFileSync(path, original);
  });

  test("L1: record refuses a reused tx, a different sender, and a transaction mined before the export", async () => {
    nowMs = W1_END + 7 * DAY + 3 * 3_600_000;
    code = {};
    const exported = await run("export", "--week", "2", "--out", out, "--from", PAYER);
    expect(exported.code).toBe(0);

    const reused = await run("record", "--week", "2", "--out", out, "--tx", hash(1));
    expect(reused.code).toBe(1);
    expect(reused.out.join("\n")).toContain("already part of an earlier record");

    payReceipt(hash(2), 2, "0x00000000000000000000000000000000000000e7");
    const stranger = await run("record", "--week", "2", "--out", out, "--tx", hash(2));
    expect(stranger.code).toBe(1);
    expect(stranger.out.join("\n")).toContain("not the paying wallet");

    payReceipt(hash(3), 2, PAYER, nowMs - 3_600_000);
    const stale = await run("record", "--week", "2", "--out", out, "--tx", hash(3));
    expect(stale.code).toBe(1);
    expect(stale.out.join("\n")).toContain("mined before the week 2 export");

    payReceipt(hash(4), 2);
    const good = await run("record", "--week", "2", "--out", out, "--tx", hash(4));
    expect(good.code).toBe(0);
    const twice = await run("record", "--week", "2", "--out", out, "--tx", hash(5));
    expect(twice.code).toBe(1);
    expect(twice.out.join("\n")).toContain("already recorded");
  });

  test("record and check refuse a folder inside the repository", async () => {
    const inside = await run("check", "--week", "1", "--out", join(import.meta.dir, "tmp-out"));
    expect(inside.code).toBe(1);
    expect(inside.out.join("\n")).toContain("inside the repository");
  });
});
