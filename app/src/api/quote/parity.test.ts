import { describe, expect, test } from "bun:test";
import { TAU, YEAR_S, callValueNumeric } from "../../pricing";
import { QUOTE_PARAMS, quoteUnits, spreadBpsFor, type MarketInputs, type SeriesInputs, type SessionName } from "./model";
import { parityFailures, toRaw, type ChainQuoter, type RawEngineQuote } from "./parity";

const WAD = 10n ** 18n;
const SESSION_INDEX: Record<SessionName, number> = { REGULAR: 0, EXTENDED: 1, CLOSED: 2, UNKNOWN: 3, HALTED: 4 };

function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const wadFrom = (value: number): bigint => BigInt(Math.round(value * 1e9)) * 10n ** 9n;
const ceilDiv = (a: bigint, b: bigint): bigint => (a + b - 1n) / b;

/** The chain side, mocked: an independent implementation of the engine quote in integer arithmetic. The option value
 * comes from numeric quadrature of the expiry integral (not the closed form the API uses), spreads and fees are
 * integer bps, and USDG rounds up for buys and down for sells, as IOptionEngine.Quote documents. Todo 23 replaces this
 * function with a call to the deployed engine on anvil. */
function mockChain(series: SeriesInputs, market: MarketInputs): ChainQuoter {
  return async ({ unitsWad, isBuy }) => {
    // A stale vol post prices sells at sigma x 1.2, floored to whole bps (decision 17); no skew in these cases.
    const sigmaBps = !isBuy && market.volStale ? Math.floor(((market.sigmaBps ?? 0) * 12_000) / 10_000) : (market.sigmaBps ?? 0);
    const sigma = sigmaBps / 10_000;
    const tauYears = (series.speed === "DAILY" ? TAU.DAILY : TAU.WEEKLY) / YEAR_S;
    const call = callValueNumeric(market.spot, series.strike, sigma, tauYears);
    const v = series.isCall ? call : Math.max(call - (market.spot - series.strike), 0);
    const vWad = wadFrom(v);
    const sBps = BigInt(Math.round(spreadBpsFor(series.strike, market.spot, market.session)));
    const minSpreadWad = wadFrom(QUOTE_PARAMS.minSpreadUsd);
    const percentWad = (vWad * sBps) / 10_000n;
    const spreadWad = percentWad > minSpreadWad ? percentWad : minSpreadWad;
    const spotWad = wadFrom(market.spot);
    const feeWad = (((spotWad * unitsWad) / WAD) * BigInt(QUOTE_PARAMS.feeBps)) / 10_000n;
    const askWad = ((vWad + spreadWad) * unitsWad) / WAD + feeWad;
    const bidBase = vWad > spreadWad ? ((vWad - spreadWad) * unitsWad) / WAD : 0n;
    const bidWad = bidBase > feeWad ? bidBase - feeWad : 0n;
    const payoff = Math.max(series.isCall ? market.spot - series.strike : series.strike - market.spot, 0);
    const rate = v > 0 ? Math.min(Math.max((v - payoff) / v, 0), 1) : 1;
    const tau = series.speed === "DAILY" ? TAU.DAILY : TAU.WEEKLY;
    const dailyWad = wadFrom(v * rate * (86_400 / tau) * (Number(unitsWad) / 1e18));
    const allIn = Number(askWad) / 1e18 / (Number(unitsWad) / 1e18);
    const breakeven = series.isCall ? series.strike + allIn : Math.max(series.strike - allIn, 0);
    const blocked = series.archived || !series.buyable || market.engineBuysPaused || market.session === "CLOSED"
      || market.session === "UNKNOWN" || market.session === "HALTED" || !market.fresh || market.priceBuysPaused
      || market.sigmaBps === null || market.volStale
      || (market.buyBlockFromMs !== null && market.buyBlockToMs !== null && market.nowMs >= market.buyBlockFromMs && market.nowMs <= market.buyBlockToMs);
    const raw: RawEngineQuote = {
      usdg: isBuy ? ceilDiv(askWad, 10n ** 12n) : bidWad / 10n ** 12n,
      vMarkWad: vWad,
      spreadBps: sBps,
      feeUsdg: ceilDiv(feeWad, 10n ** 12n),
      dailyCostUsdg: ceilDiv(dailyWad, 10n ** 12n),
      breakevenWad: wadFrom(breakeven),
      sigmaBps: BigInt(Math.round(sigma * 10_000)),
      session: SESSION_INDEX[market.session],
      buyable: !blocked,
    };
    return raw;
  };
}

describe("quote parity with the engine (mocked chain side)", () => {
  test("200 random cases agree within 0.5% on every money field", async () => {
    const random = prng(20261016);
    const sessions: SessionName[] = ["REGULAR", "REGULAR", "REGULAR", "EXTENDED", "CLOSED", "UNKNOWN"];
    const failures: string[] = [];
    for (let i = 0; i < 200; i++) {
      const spot = 20 + random() * 780;
      const strike = Math.round(spot * (0.7 + random() * 0.6) * 100) / 100;
      const series: SeriesInputs = {
        isCall: random() < 0.5, speed: random() < 0.5 ? "DAILY" : "WEEKLY", strike, buyable: random() < 0.9, archived: false,
      };
      const market: MarketInputs = {
        spot, session: sessions[Math.floor(random() * sessions.length)]!, fresh: true, priceBuysPaused: false, engineBuysPaused: false,
        sigmaBps: 2_000 + Math.floor(random() * 10_000), volStale: random() < 0.1, buyBlockFromMs: null, buyBlockToMs: null, nowMs: 1_000_000,
      };
      const unitsWad = BigInt(Math.round((0.01 + random() * 9_999) * 1e6)) * 10n ** 12n;
      const isBuy = random() < 0.6;
      const api = quoteUnits(series, market, unitsWad, isBuy)!;
      const chain = await mockChain(series, market)({ id: `case-${i}`, unitsWad, isBuy });
      for (const failure of parityFailures(toRaw(api), chain)) {
        failures.push(`case ${i} ${series.speed} ${series.isCall ? "call" : "put"} K=${strike} S=${spot.toFixed(2)} ${isBuy ? "buy" : "sell"} ${market.session}: ${failure}`);
      }
    }
    expect(failures).toEqual([]);
  });

  test("the harness flags a quote that is off by more than the tolerance", () => {
    const series: SeriesInputs = { isCall: true, speed: "WEEKLY", strike: 100, buyable: true, archived: false };
    const market: MarketInputs = {
      spot: 100, session: "REGULAR", fresh: true, priceBuysPaused: false, engineBuysPaused: false, sigmaBps: 5_000, volStale: false,
      buyBlockFromMs: null, buyBlockToMs: null, nowMs: 1,
    };
    const api = toRaw(quoteUnits(series, market, WAD, true)!);
    expect(parityFailures(api, api)).toEqual([]);
    expect(parityFailures(api, { ...api, usdg: api.usdg * 101n / 100n }).some((line) => line.startsWith("usdg"))).toBe(true);
    expect(parityFailures(api, { ...api, usdg: api.usdg * 1004n / 1000n })).toEqual([]);
    expect(parityFailures(api, { ...api, buyable: !api.buyable })).toEqual([`buyable: api ${api.buyable} chain ${!api.buyable}`]);
  });
});
