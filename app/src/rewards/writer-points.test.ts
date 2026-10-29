import { describe, expect, test } from "bun:test";
import { fixed, split, usdgDays, walletWeights, weekTable, type PoolFlow, type WeekInput } from "./writer-points";

const DAY = 86_400;
const START = 1_800_000_000;
const END = START + 7 * DAY;
const M = 1_000_000n;
const S = 10n ** 18n;
const TOKENS = 10n ** 18n;
let n = 0;
const dep = (account: string, usdg: number, ts: number, shares = usdg): PoolFlow =>
  ({ kind: "deposit", account, block: BigInt(++n), logIndex: 0, ts, shares18: BigInt(shares) * S, assetsMicro: BigInt(usdg) * M });
const out = (account: string, shares: number, ts: number): PoolFlow =>
  ({ kind: "out", account, block: BigInt(++n), logIndex: 0, ts, shares18: BigInt(shares) * S, assetsMicro: 0n });
const input = (flows: PoolFlow[], over: Partial<WeekInput> = {}): WeekInput => ({
  flows, startSec: START, endSec: END, poolUnits: 1_000_000n * TOKENS, perWalletCapBps: 1_000, minTimeWeightedUsdg: 1_000,
  redistributeOverCap: false, excluded: new Map([["0xteam", "project wallet (owner)"]]), ...over,
});

describe("writer points from a fake indexer history", () => {
  test("time weighting: a deposit before the week counts from its start; one mid-week from its own time", () => {
    const w = walletWeights([dep("a", 1_000, START - 5 * DAY), dep("b", 2_000, START + 3.5 * DAY)], START, END);
    expect(usdgDays(w.get("a")!.weight)).toBe("7000.00");
    expect(usdgDays(w.get("b")!.weight)).toBe("7000.00");
  });

  test("requestWithdraw (shares out) stops the clock for those shares; transfers in do not count; flows after the end are ignored", () => {
    const flows = [dep("a", 3_000, START), out("a", 1_000, START + 2 * DAY), out("a", 5_000, START + 4 * DAY), dep("c", 9_000, END + 1)];
    const w = walletWeights(flows, START, END);
    // 3,000 x 2 days + 2,000 x 2 days, then everything left
    expect(usdgDays(w.get("a")!.weight)).toBe("10000.00");
    expect(w.get("a")!.basisEnd).toBe(0n);
    expect(w.has("c")).toBe(false);
  });

  test("shares bought at a different NAV keep their own USDG basis; a partial exit takes its pro-rata basis", () => {
    const w = walletWeights([dep("a", 1_000, START, 1_000), dep("a", 1_100, START, 1_000), out("a", 1_000, START + DAY)], START, END);
    expect(w.get("a")!.basisEnd).toBe(1_050n * M);
  });

  test("minimum is exact at 1,000 USDG time-weighted; team wallets and zero weight never qualify", () => {
    const table = weekTable(input([dep("a", 1_000, START), dep("b", 999, START), dep("0xteam", 50_000, START), dep("c", 2_000, START), out("c", 2_000, START)]));
    const row = (address: string) => table.rows.find((r) => r.address === address)!;
    expect(row("a").eligible).toBe(true);
    expect(row("b").reason).toBe("time-weighted deposit under 1000 USDG");
    expect(row("0xteam").reason).toBe("excluded: project wallet (owner)");
    expect(row("c").reason).toBe("no deposit held during the week");
    expect(table.eligibleWallets).toBe(1);
  });

  test("the 10% cap: the excess is not paid and stays unallocated; allocated + unallocated == pool", () => {
    const flows = Array.from({ length: 4 }, (_, i) => dep(`w${i}`, 1_000 * (i + 1), START));
    const table = weekTable(input(flows));
    for (const row of table.rows) expect(row.units).toBe(100_000n * TOKENS);
    expect(table.allocatedUnits).toBe(400_000n * TOKENS);
    expect(table.unallocatedUnits).toBe(600_000n * TOKENS);
  });

  test("with redistributeOverCap the excess is water-filled over the others, still capped", () => {
    const flows = [dep("big", 100_000, START), ...Array.from({ length: 12 }, (_, i) => dep(`s${i}`, 1_000, START))];
    const table = weekTable(input(flows, { redistributeOverCap: true }));
    expect(table.rows[0]!.address).toBe("big");
    expect(table.rows[0]!.units).toBe(100_000n * TOKENS);
    for (const row of table.rows.slice(1)) expect(row.units).toBe(75_000n * TOKENS);
    expect(table.unallocatedUnits).toBe(0n);
    const plain = weekTable(input(flows));
    expect(plain.rows[1]!.units).toBe(1_000_000n * TOKENS * 1_000n / 112_000n);
    expect(plain.allocatedUnits + plain.unallocatedUnits).toBe(1_000_000n * TOKENS);
  });

  test("integer split never exceeds the pool, even with awkward weights", () => {
    const result = split(new Map([["a", 1n], ["b", 1n], ["c", 1n]]), 100n, 100n, false);
    const total = [...result.values()].reduce((sum, r) => sum + r.units, 0n);
    expect(total).toBe(99n);
  });

  test("deterministic: the same history in any input order gives the same table and digest; a change moves the digest", () => {
    const flows = [dep("a", 1_500, START + 100), dep("b", 2_500, START + 200), out("a", 500, START + 3 * DAY)];
    const one = weekTable(input(flows));
    const two = weekTable(input([...flows].reverse()));
    expect(two.digest).toBe(one.digest);
    expect(two.rows).toEqual(one.rows);
    expect(weekTable(input(flows.slice(0, 2))).digest).not.toBe(one.digest);
  });

  test("no eligible wallet: nothing is allocated; fixed() parses indexer decimals", () => {
    const table = weekTable(input([]));
    expect(table.allocatedUnits).toBe(0n);
    expect(table.unallocatedUnits).toBe(1_000_000n * TOKENS);
    expect(fixed("12.5", 6)).toBe(12_500_000n);
    expect(fixed("0.000000000001", 18)).toBe(1_000_000n);
    expect(fixed("7", 18)).toBe(7n * S);
  });

  test("a transfer out to a third party mixed with a transfer in: only the wallet's own deposit counts, the out takes basis pro rata", () => {
    // a deposits 4,000; receives 1,000 shares from b (ignored); sends 3,000 shares to c (takes 3/4 of a's own basis)
    // flows are built in chain order (block numbers grow with time)
    const flows = [dep("a", 4_000, START), dep("b", 1_000, START), out("b", 1_000, START + DAY), out("a", 3_000, START + 2 * DAY)];
    const w = walletWeights(flows, START, END);
    // a: 4,000 x 2 days + 1,000 x 5 days = 13,000; the 1,000 shares a received never add to its basis
    expect(usdgDays(w.get("a")!.weight)).toBe("13000.00");
    expect(w.get("a")!.basisEnd).toBe(1_000n * M);
    // b: 1,000 x 1 day, then it sent everything
    expect(usdgDays(w.get("b")!.weight)).toBe("1000.00");
    expect(w.has("c")).toBe(false); // c only received shares
    // moving more than it deposited cannot push a below zero
    const over = walletWeights([dep("a", 1_000, START), out("a", 5_000, START + DAY)], START, END);
    expect(over.get("a")!.basisEnd).toBe(0n);
  });

  test("flows exactly at the week's start count from the start; flows exactly at its end belong to the next week", () => {
    const w = walletWeights([dep("a", 1_000, START), out("d", 1, START), dep("c", 1_000, END - 1), dep("b", 1_000, END)], START, END);
    expect(usdgDays(w.get("a")!.weight)).toBe("7000.00");
    expect(w.has("b")).toBe(false);
    expect(w.get("c")!.weight).toBe(1_000n * M); // one second
    const exit = walletWeights([dep("e", 1_000, START - DAY), out("e", 1_000, START)], START, END);
    expect(exit.get("e")!.weight).toBe(0n); // asked to withdraw at the first second of the week: nothing counts
    const late = walletWeights([dep("f", 1_000, START - DAY), out("f", 1_000, END)], START, END);
    expect(usdgDays(late.get("f")!.weight)).toBe("7000.00"); // the exit at END is next week's
  });

  test("sybil split (accepted limit, decision 76): the cap is per wallet, so one person splitting into wallets collects more", () => {
    const others = Array.from({ length: 3 }, (_, i) => dep(`o${i}`, 20_000, START));
    const single = weekTable(input([dep("whale", 100_000, START), ...others]));
    const split = weekTable(input([...Array.from({ length: 10 }, (_, i) => dep(`whale${i}`, 10_000, START)), ...others]));
    const whaleSingle = single.rows.find((r) => r.address === "whale")!.units;
    const whaleSplit = split.rows.filter((r) => r.address.startsWith("whale")).reduce((sum, r) => sum + r.units, 0n);
    expect(whaleSingle).toBe(100_000n * TOKENS); // capped at 10%
    expect(whaleSplit).toBe(1_000_000n * TOKENS * 100_000n / 160_000n); // 625,000: ten wallets, none capped
    expect(whaleSplit).toBeGreaterThan(whaleSingle);
    // the honest writers get the same pro-rata amount either way (here also capped at 10% each)
    for (const r of split.rows.filter((row) => row.address.startsWith("o"))) expect(r.units).toBe(100_000n * TOKENS);
  });
});

