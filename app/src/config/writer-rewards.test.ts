import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  currentWeek, excludedWallets, programStatus, unitsText, weekBounds, weeklyPoolUnits, writerRewards, writerRewardsSchema,
} from "./writer-rewards";

const repo = join(import.meta.dir, "../../..");
const WEEK = 7 * 86_400_000;

describe("writer rewards config (zero-seed launch)", () => {
  test("defaults: 1,000,000 LMNS a week = 0.1% of a 1B supply, 8 weeks, 10% wallet cap, 1,000 USDG minimum, switched on", () => {
    expect(writerRewards.enabled).toBe(true);
    expect(weeklyPoolUnits()).toBe(1_000_000n * 10n ** 18n);
    expect(unitsText(weeklyPoolUnits(), 18)).toBe("1000000");
    expect(writerRewards.weeks).toBe(8);
    expect(writerRewards.perWalletCapBps).toBe(1_000);
    expect(writerRewards.minTimeWeightedUsdg).toBe(1_000);
    expect(writerRewards.EXCLUDED_WALLETS).toEqual([]);
    expect(writerRewards.tokenAddress).toBe("");
    expect(programStatus(Date.now())).toBe("awaiting_token");
  });

  test("the pool scales to 0.1% of the real supply", () => {
    expect(weeklyPoolUnits({ ...writerRewards, tokenTotalSupply: "420690000000" })).toBe(420_690_000n * 10n ** 18n);
    expect(weeklyPoolUnits({ ...writerRewards, tokenTotalSupply: "1000000000", tokenDecimals: 6 })).toBe(1_000_000n * 10n ** 6n);
  });

  test("a token address needs a start; weeks run back to back from it", () => {
    const parsed = writerRewardsSchema.safeParse({ ...writerRewards, tokenAddress: "0x00000000000000000000000000000000000001aa" as const });
    expect(parsed.success).toBe(false);
    const config = { ...writerRewards, tokenAddress: "0x00000000000000000000000000000000000001aa" as const, startAt: "2026-11-09T00:00:00.000Z" };
    const start = Date.parse(config.startAt);
    expect(programStatus(start - 1, config)).toBe("scheduled");
    expect(programStatus(start, config)).toBe("active");
    expect(programStatus(start + 8 * WEEK, config)).toBe("ended");
    expect(weekBounds(1, config)).toEqual({ startMs: start, endMs: start + WEEK });
    expect(weekBounds(8, config)!.endMs).toBe(start + 8 * WEEK);
    expect(weekBounds(9, config)).toBeNull();
    expect(weekBounds(0, config)).toBeNull();
    expect(currentWeek(start + WEEK + 5, config)).toBe(2);
    expect(currentWeek(start + 20 * WEEK, config)).toBe(8);
    expect(currentWeek(start - 5, config)).toBeNull();
  });

  test("exclusions: zero address, every deployment contract, the project wallets and EXCLUDED_WALLETS", () => {
    const map = excludedWallets({ pool: "0x00000000000000000000000000000000000010AB", engine: "" },
      { ...writerRewards, EXCLUDED_WALLETS: ["0x00000000000000000000000000000000000000Ff"] });
    expect(map.get("0x0000000000000000000000000000000000000000")).toBe("zero address");
    expect(map.get("0x00000000000000000000000000000000000010ab")).toBe("Lemniscate contract (pool)");
    expect(map.get("0x00000000000000000000000000000000000000ff")).toBe("excluded by the owner");
    for (const value of Object.values(writerRewards.projectWallets)) expect(map.has(value.toLowerCase())).toBe(true);
  });

  test("project wallets are exactly the operator wallets of the mainnet address file (when the private docs are present)", () => {
    const file = join(repo, "../docs/runbooks/mainnet-addresses.json");
    if (!existsSync(file)) return; // the public repo has no docs/; the copy in the config is the record
    const addresses = JSON.parse(readFileSync(file, "utf8")) as Record<string, string>;
    expect(Object.keys(writerRewards.projectWallets).sort()).toEqual(Object.keys(addresses).sort());
    for (const [role, value] of Object.entries(addresses)) expect(writerRewards.projectWallets[role]!.toLowerCase()).toBe(value.toLowerCase());
  });

  test("the website shows the same token, amount and rules (web/dist/writer-rewards.json and launch.json agree with this config)", () => {
    const site = JSON.parse(readFileSync(join(repo, "web/dist/writer-rewards.json"), "utf8"));
    const launch = JSON.parse(readFileSync(join(repo, "web/dist/launch.json"), "utf8"));
    expect(site.tokenAddress.toLowerCase()).toBe(writerRewards.tokenAddress.toLowerCase());
    expect(launch.tokenAddress.toLowerCase()).toBe(writerRewards.tokenAddress.toLowerCase());
    expect(launch.tokenSymbol).toBe(writerRewards.tokenSymbol);
    expect(site).toEqual({
      tokenSymbol: writerRewards.tokenSymbol,
      tokenAddress: site.tokenAddress,
      startAt: writerRewards.startAt,
      weeklyPoolTokens: unitsText(weeklyPoolUnits(), writerRewards.tokenDecimals),
      weeklyPoolPctOfSupply: writerRewards.weeklyPoolBpsOfSupply / 100,
      tokenTotalSupply: writerRewards.tokenTotalSupply,
      weeks: writerRewards.weeks,
      perWalletCapPct: writerRewards.perWalletCapBps / 100,
      minTimeWeightedUsdg: writerRewards.minTimeWeightedUsdg,
      overCapPaidToOthers: writerRewards.redistributeOverCap,
    });
  });
});
