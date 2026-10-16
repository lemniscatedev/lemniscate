import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { maxUint128, maxUint256 } from "viem";
import { applyMigrations, createTestDatabase, testDatabaseUrl, type TestDatabase } from "../testing/db";
import { stressLossBps, deltaGammaPnl } from "./stress";
import { ADDR, FakeChain, SERIES_CALL, ev, makeIndexer, syncToHead } from "./test-support";
import { bytes32Text, optionTokens, sessionName, signedWad, speedName, usdg, wad } from "./units";

describe("decimalsCorrect", () => {
  test("USDG has 6 decimals", () => {
    expect(usdg(0n)).toBe("0");
    expect(usdg(1n)).toBe("0.000001");
    expect(usdg(999_999n)).toBe("0.999999");
    expect(usdg(1_000_000n)).toBe("1");
    expect(usdg(123_456_789n)).toBe("123.456789");
    expect(usdg(maxUint128)).toBe("340282366920938463463374607431768.211455");
  });

  test("WAD and option-token amounts have 18 decimals", () => {
    expect(wad(0n)).toBe("0");
    expect(wad(1n)).toBe("0.000000000000000001");
    expect(wad(10n ** 18n - 1n)).toBe("0.999999999999999999");
    expect(wad(10n ** 18n)).toBe("1");
    expect(optionTokens(3n * 10n ** 18n + 5n)).toBe("3.000000000000000005");
    expect(wad(maxUint256)).toBe("115792089237316195423570985008687907853269984665640564039457.584007913129639935");
  });

  test("no float loss above 2^53", () => {
    expect(usdg(9_007_199_254_740_993n)).toBe("9007199254.740993");
    expect(wad(9_007_199_254_740_993n)).toBe("0.009007199254740993");
    expect(wad("9007199254740993")).toBe("0.009007199254740993");
  });

  test("signed WAD values keep their sign", () => {
    expect(signedWad(-1n)).toBe("-0.000000000000000001");
    expect(signedWad(-5n * 10n ** 17n)).toBe("-0.5");
    expect(signedWad(0n)).toBe("0");
  });

  test("enums and reason codes decode", () => {
    expect(sessionName(0)).toBe("REGULAR");
    expect(sessionName(4)).toBe("HALTED");
    expect(sessionName(9)).toBe("UNKNOWN");
    expect(speedName(0)).toBe("DAILY");
    expect(speedName(1)).toBe("WEEKLY");
    const split = `0x${Buffer.from("SPLIT").toString("hex").padEnd(64, "0")}`;
    expect(bytes32Text(split)).toBe("SPLIT");
    expect(bytes32Text(`0x${"00".repeat(32)}`)).toBe("");
    expect(bytes32Text(`0x${"ff".repeat(32)}`)).toBe(`0x${"ff".repeat(32)}`);
  });
});

const suite = testDatabaseUrl() ? describe : describe.skip;

suite("decimalsCorrect through the database", () => {
  let db: TestDatabase;
  beforeAll(async () => {
    db = (await createTestDatabase("decimals"))!;
    await applyMigrations(db);
  });
  afterAll(async () => db.close());

  test("boundary amounts survive a round trip through the indexer and Postgres exactly", async () => {
    const chain = new FakeChain();
    chain.mine([ev.seriesListed(SERIES_CALL, ADDR.nvda, true, 0, maxUint128, ADDR.tokenCall)]);
    chain.mine([
      ev.bought(SERIES_CALL, ADDR.alice, ADDR.alice, maxUint256, maxUint256, maxUint128, 1n, 65_535n),
      ev.accrued(SERIES_CALL, 1n, maxUint256, 0n),
      ev.shield(ADDR.alice, ADDR.nvda, SERIES_CALL, 1n, 1n),
    ]);
    const { state } = await makeIndexer(db.sql, chain);
    await syncToHead(state);
    const trade = (await db.sql`SELECT units, shares, usdg, v_mark, sigma_bps FROM trades`)[0]!;
    expect(trade.units).toBe(wad(maxUint256));
    expect(trade.shares).toBe(wad(maxUint256));
    expect(trade.usdg).toBe("340282366920938463463374607431768.211455000000000000");
    expect(trade.v_mark).toBe("0.000000000000000001");
    expect(trade.sigma_bps).toBe(65_535);
    const series = (await db.sql`SELECT strike FROM series`)[0]!;
    expect(series.strike).toBe("340282366920938463463.374607431768211455");
    const norm = (await db.sql`SELECT norm, v_mark FROM norm_history`)[0]!;
    expect(norm.norm).toBe("0.000000000000000001");
    expect(norm.v_mark).toBe(wad(maxUint256));
  });
});

describe("stress loss", () => {
  const WAD = 10n ** 18n;

  test("delta-gamma P&L is exact in bigint math", () => {
    expect(deltaGammaPnl(-2n * WAD, WAD / 10n, 30n * WAD)).toBe(-15n * WAD);
    expect(deltaGammaPnl(-2n * WAD, WAD / 10n, -30n * WAD)).toBe(105n * WAD);
    expect(deltaGammaPnl(0n, 0n, 30n * WAD)).toBe(0n);
  });

  test("worst of the up and down gap, in basis points of NAV", () => {
    expect(stressLossBps({ deltaWad: -2n * WAD, gammaWad: WAD / 10n, spotWad: 120n * WAD, navWad: 1350n * WAD })).toBe("111.1111");
    // long gamma and no delta never loses
    expect(stressLossBps({ deltaWad: 0n, gammaWad: WAD, spotWad: 100n * WAD, navWad: 1000n * WAD })).toBe("0");
    // symmetric short gamma loses on both sides
    expect(stressLossBps({ deltaWad: 0n, gammaWad: -WAD / 5n, spotWad: 100n * WAD, navWad: 1000n * WAD })).toBe("625");
  });

  test("a non-positive NAV with a loss reports the cap", () => {
    expect(stressLossBps({ deltaWad: -WAD, gammaWad: 0n, spotWad: 100n * WAD, navWad: 0n })).toBe("1000000");
    expect(stressLossBps({ deltaWad: WAD, gammaWad: 0n, spotWad: 100n * WAD, navWad: -5n * WAD })).toBe("1000000");
  });
});
