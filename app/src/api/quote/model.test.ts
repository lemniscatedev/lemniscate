import { describe, expect, test } from "bun:test";
import { TAU, YEAR_S, callValue, fundingStep, putValue } from "../../pricing";
import {
  QUOTE_PARAMS, buyBlockReason, displayCost, looseWad, parseWad, quoteUnits, spreadBpsFor, unitQuote, usdgMicro, usdgText,
  wadText, type MarketInputs, type SeriesInputs,
} from "./model";

const WAD = 10n ** 18n;
const market = (over: Partial<MarketInputs> = {}): MarketInputs => ({
  spot: 100, session: "REGULAR", fresh: true, priceBuysPaused: false, engineBuysPaused: false, sigmaBps: 5_000, volStale: false,
  buyBlockFromMs: null, buyBlockToMs: null, nowMs: 1_000_000, ...over,
});
const series = (over: Partial<SeriesInputs> = {}): SeriesInputs => ({ isCall: true, speed: "WEEKLY", strike: 100, buyable: true, archived: false, ...over });

describe("spread and fee", () => {
  test("spread runs from 1.5% at the money to 4% far away, times the session factor", () => {
    expect(spreadBpsFor(100, 100, "REGULAR")).toBe(150);
    expect(spreadBpsFor(130, 100, "REGULAR")).toBeCloseTo(400, 9);
    expect(spreadBpsFor(70, 100, "REGULAR")).toBeCloseTo(400, 9);
    expect(spreadBpsFor(200, 100, "REGULAR")).toBe(400);
    expect(spreadBpsFor(100, 100, "EXTENDED")).toBe(225);
    expect(spreadBpsFor(100, 100, "CLOSED")).toBe(450);
    expect(spreadBpsFor(100, 100, "UNKNOWN")).toBe(450);
  });

  test("the overview example: Weekly 100 call at 50% is worth about 2.45 and costs about $0.35 a day", () => {
    const q = quoteUnits(series(), market(), WAD, true)!;
    expect(Number(q.vMarkWad) / 1e18).toBeCloseTo(2.44736, 3);
    expect(displayCost(q.dailyCostUsdg)).toBe("costs about $0.35/day");
    // ask = mark + 1.5% spread (3.67 cents) + 3 bps of 100 = 3 cents
    expect(Number(q.usdg) / 1e6).toBeCloseTo(2.44736 * 1.015 + 0.03, 2);
    expect(q.feeUsdg).toBe(30_000n);
    expect(q.buyable).toBe(true);
  });

  test("the minimum spread is one cent a unit and the bid never goes below zero", () => {
    const far = series({ strike: 200 });
    const buy = quoteUnits(far, market(), WAD, true)!;
    const sell = quoteUnits(far, market(), WAD, false)!;
    expect(Number(buy.usdg) / 1e6).toBeGreaterThanOrEqual(0.01 + 0.03);
    expect(sell.usdg).toBe(0n);
  });

  test("buys round up and sells round down to the micro-USDG", () => {
    const units = 3n * WAD + 333n * 10n ** 15n;
    const ask = quoteUnits(series(), market(), units, true)!;
    const bid = quoteUnits(series(), market(), units, false)!;
    const u = unitQuote(series(), market(), false)!;
    const n = Number(units) / 1e18;
    expect(Number(ask.usdg)).toBeGreaterThanOrEqual(Math.floor((u.askPerUnit * n + 0.0003 * 100 * n) * 1e6));
    expect(bid.usdg).toBeLessThan(ask.usdg);
  });
});

describe("daily cost (R6)", () => {
  test("is the funding rate over one day, matching fundingStep in the small-step limit", () => {
    for (const speed of ["DAILY", "WEEKLY"] as const) {
      for (const strike of [80, 95, 100, 105, 130]) {
        for (const isCall of [true, false]) {
          const s = series({ speed, strike, isCall });
          const m = market();
          const unit = unitQuote(s, m, false)!;
          const dt = 1;
          const shrink = 1 - fundingStep(1, unit.v, unit.payoff, dt, TAU[speed]);
          const perDayFromStep = unit.v * shrink * (QUOTE_PARAMS.fundingDaySeconds / dt);
          const q = quoteUnits(s, m, 10n * WAD, true)!;
          const expected = perDayFromStep * 10;
          expect(Math.abs(Number(q.dailyCostUsdg) / 1e6 - expected)).toBeLessThanOrEqual(Math.max(1e-6, Math.abs(expected) * 1e-4));
        }
      }
    }
  });

  test("a deep in-the-money option pays almost nothing and an out-of-the-money one pays 1/7 of its units a day (Weekly)", () => {
    const itm = quoteUnits(series({ strike: 50 }), market(), WAD, true)!;
    expect(Number(itm.dailyCostUsdg) / 1e6).toBeLessThan(0.01);
    const otm = unitQuote(series({ strike: 400 }), market(), false)!;
    expect(otm.dayFundingFraction).toBeCloseTo(1 / 7, 9);
  });

  test("copy shape", () => {
    expect(displayCost(0n)).toBe("costs less than $0.01/day");
    expect(displayCost(4_999n)).toBe("costs less than $0.01/day");
    expect(displayCost(5_000n)).toBe("costs about $0.01/day");
    expect(displayCost(12_340_000n)).toBe("costs about $12.34/day");
  });
});

describe("put, parity and breakeven", () => {
  test("put mark equals call mark minus (S-K)", () => {
    const call = unitQuote(series({ isCall: true, strike: 110 }), market(), false)!;
    const put = unitQuote(series({ isCall: false, strike: 110 }), market(), false)!;
    expect(call.v - put.v).toBeCloseTo(100 - 110, 9);
    expect(put.v).toBeCloseTo(putValue(100, 110, 0.5, TAU.WEEKLY / YEAR_S), 12);
    expect(call.v).toBeCloseTo(callValue(100, 110, 0.5, TAU.WEEKLY / YEAR_S), 12);
  });

  test("breakeven is strike plus the all-in cost for a call and strike minus it for a put", () => {
    const callQ = quoteUnits(series({ isCall: true }), market(), WAD, true)!;
    expect(Number(callQ.breakevenWad) / 1e18).toBeCloseTo(100 + Number(callQ.usdg) / 1e6, 5);
    const putQ = quoteUnits(series({ isCall: false }), market(), WAD, true)!;
    expect(Number(putQ.breakevenWad) / 1e18).toBeCloseTo(100 - Number(putQ.usdg) / 1e6, 5);
  });
});

describe("buy blocks", () => {
  test("each condition blocks buys with its own reason, in priority order", () => {
    const s = series();
    expect(buyBlockReason(s, market())).toBeNull();
    expect(buyBlockReason(series({ archived: true }), market())).toBe("SERIES_ARCHIVED");
    expect(buyBlockReason(series({ buyable: false }), market())).toBe("SERIES_NOT_BUYABLE");
    expect(buyBlockReason(s, market({ engineBuysPaused: true }))).toBe("BUYS_PAUSED");
    expect(buyBlockReason(s, market({ session: "CLOSED" }))).toBe("SESSION_CLOSED");
    expect(buyBlockReason(s, market({ session: "UNKNOWN" }))).toBe("SESSION_UNKNOWN");
    expect(buyBlockReason(s, market({ session: "HALTED" }))).toBe("SESSION_HALTED");
    expect(buyBlockReason(s, market({ fresh: false }))).toBe("PRICE_STALE");
    expect(buyBlockReason(s, market({ priceBuysPaused: true }))).toBe("PRICE_PAUSED");
    expect(buyBlockReason(s, market({ sigmaBps: null }))).toBe("NO_VOL");
    expect(buyBlockReason(s, market({ volStale: true }))).toBe("VOL_STALE");
    expect(buyBlockReason(s, market({ buyBlockFromMs: 900_000, buyBlockToMs: 1_100_000 }))).toBe("EARNINGS_BLOCK");
    expect(buyBlockReason(s, market({ buyBlockFromMs: 1_100_000, buyBlockToMs: 1_200_000 }))).toBeNull();
    expect(buyBlockReason(s, market({ spot: 0 }))).toBe("NO_PRICE");
  });

  test("EXTENDED allows buys; sells stay quotable in every session and HALTED marks the sell as queued", () => {
    expect(quoteUnits(series(), market({ session: "EXTENDED" }), WAD, true)!.buyable).toBe(true);
    for (const session of ["REGULAR", "EXTENDED", "CLOSED", "UNKNOWN", "HALTED"] as const) {
      const sell = quoteUnits(series(), market({ session }), WAD, false)!;
      expect(sell.usdg).toBeGreaterThan(0n);
      expect(sell.sellQueued).toBe(session === "HALTED");
    }
  });

  test("a stale vol post prices sells at sigma x 0.8 (review F09/F13) and blocks buys", () => {
    const fresh = unitQuote(series(), market(), true)!;
    const stale = unitQuote(series(), market({ volStale: true }), true)!;
    expect(fresh.sigmaBps).toBe(5_000);
    expect(stale.sigmaBps).toBe(4_000);
    expect(unitQuote(series(), market({ sigmaBps: 4_000, volStale: true }), true)!.sigmaBps).toBe(3_200);
    // buys on a stale post are blocked, and a quote for them is still priced at the posted sigma
    expect(unitQuote(series(), market({ volStale: true }), false)!.sigmaBps).toBe(5_000);
    expect(quoteUnits(series(), market({ volStale: true }), WAD, true)!.buyable).toBe(false);
  });

  test("no vol ever posted means no quote", () => {
    expect(quoteUnits(series(), market({ sigmaBps: null }), WAD, true)).toBeNull();
  });
});

describe("number helpers", () => {
  test("parseWad accepts positive decimals and rejects the rest", () => {
    expect(parseWad("1")).toBe(WAD);
    expect(parseWad("0.5")).toBe(WAD / 2n);
    expect(parseWad("0")).toBeNull();
    expect(parseWad("-1")).toBeNull();
    expect(parseWad("1e3")).toBeNull();
    expect(parseWad("1.1234567890123456789")).toBeNull();
    expect(parseWad("")).toBeNull();
  });
  test("text conversions", () => {
    expect(usdgText(1_234_567n)).toBe("1.234567");
    expect(usdgText(0n)).toBe("0.000000");
    expect(wadText(2_446_800_000_000_000_000n)).toBe("2.446800");
    expect(usdgMicro("12.3456789")).toBe(12_345_678n);
    expect(looseWad("4.000000000000000000")).toBe(4n * WAD);
  });
});

describe("skew from the posted skewK (decision 17)", () => {
  // (kPut 1.2 << 32) | kCall 0.4, the same packing as the engine test test_R2_skewDecoding.
  const skewK = (12_000n << 32n) | 4_000n;
  test("sigma(K) matches the engine's decoding: 5000 / 5364 / 6338", () => {
    const m = market({ skewK });
    expect(unitQuote(series({ isCall: true, strike: 100 }), m, false)!.sigmaBps).toBe(5_000);
    expect(unitQuote(series({ isCall: true, strike: 120 }), m, false)!.sigmaBps).toBe(5_364);
    expect(unitQuote(series({ isCall: false, strike: 80 }), m, false)!.sigmaBps).toBe(6_338);
  });
  test("a skewed series is priced at its own sigma, and the stale cut multiplies the skewed sigma", () => {
    const q = quoteUnits(series({ isCall: true, strike: 120 }), market({ skewK }), WAD, true)!;
    expect(q.sigmaBps).toBe(5_364);
    expect(Number(q.vMarkWad) / 1e18).toBeCloseTo(callValue(100, 120, 0.5364, TAU.WEEKLY / YEAR_S), 9);
    // 5000 x (1 + 0.4 ln 1.2) = 5364, then x 0.8 = 4291.2
    expect(unitQuote(series({ isCall: true, strike: 120 }), market({ skewK, volStale: true }), true)!.sigmaBps).toBe(4_291);
  });
  test("sigma is clamped to the pricing domain", () => {
    expect(unitQuote(series(), market({ sigmaBps: 500 }), false)!.sigmaBps).toBe(1_000);
    expect(unitQuote(series(), market({ sigmaBps: 40_000, volStale: true }), true)!.sigmaBps).toBe(24_000);
    expect(unitQuote(series(), market({ sigmaBps: 1_100, volStale: true }), true)!.sigmaBps).toBe(1_000);
  });
});

describe("inventory term (decision 17)", () => {
  const nav = 1_000_000;
  const capVega = (nav * 60) / 10_000; // 6000 USDG per vol point
  test("V_mark = V x (1 + 0.15 n) with n the post-trade name vega over 0.6% of NAV, clamped to [0, 1]", () => {
    const base = unitQuote(series(), market(), false, 1)!;
    expect(base.inventoryApplied).toBe(false);
    expect(base.inventory).toBe(0);
    const vegaPerUnit = base.greeks.vega;
    const half = unitQuote(series(), market({ book: { navUsd: nav, nameVegaUsd: capVega / 2 - vegaPerUnit } }), false, 1)!;
    expect(half.inventoryApplied).toBe(true);
    expect(half.inventory).toBeCloseTo(0.5, 9);
    expect(half.vMark).toBeCloseTo(base.v * (1 + 0.15 * 0.5), 12);
    const full = unitQuote(series(), market({ book: { navUsd: nav, nameVegaUsd: 10 * capVega } }), false, 1)!;
    expect(full.inventory).toBe(1);
    expect(full.vMark).toBeCloseTo(base.v * 1.15, 12);
    const empty = unitQuote(series(), market({ book: { navUsd: nav, nameVegaUsd: 0 } }), true, 10)!;
    expect(empty.inventory).toBe(0);
  });
  test("a sell lowers the post-trade vega, a buy raises it; the spread is taken on the marked-up value", () => {
    const m = market({ book: { navUsd: nav, nameVegaUsd: capVega / 2 } });
    const buy = unitQuote(series(), m, false, 100)!;
    const sell = unitQuote(series(), m, true, 100)!;
    expect(buy.inventory).toBeGreaterThan(0.5);
    expect(sell.inventory).toBeLessThan(0.5);
    expect(buy.spreadPerUnit).toBeCloseTo(Math.max(0.01, (buy.vMark * buy.spreadBps) / 10_000), 12);
    expect(buy.vPrice).toBe(buy.v);
  });
  test("zero or negative NAV pins n at 1; vega never goes below zero", () => {
    expect(unitQuote(series(), market({ book: { navUsd: 0, nameVegaUsd: 0 } }), false, 1)!.inventory).toBe(1);
    expect(unitQuote(series(), market({ book: { navUsd: nav, nameVegaUsd: 0 } }), true, 1_000_000)!.inventory).toBe(0);
  });
  test("the quote carries the marked-up mark, the inventory and daily cost on the unmarked value", () => {
    const m = market({ book: { navUsd: nav, nameVegaUsd: capVega } });
    const q = quoteUnits(series(), m, 10n * WAD, true)!;
    const plain = quoteUnits(series(), market(), 10n * WAD, true)!;
    expect(q.inventory).toBe(1);
    expect(q.inventoryApplied).toBe(true);
    expect(Number(q.vMarkWad) / Number(plain.vMarkWad)).toBeCloseTo(1.15, 9);
    expect(q.dailyCostUsdg).toBe(plain.dailyCostUsdg);
    expect(q.usdg).toBeGreaterThan(plain.usdg);
  });
});

describe("caps in buyable and blockReason", () => {
  const nav = 1_000_000; // series cap min(40000, 2% = 20000) = 20000; name cap 8% = 80000; total 35% = 350000
  const book = (over: Partial<NonNullable<MarketInputs["book"]>> = {}) => ({ navUsd: nav, nameVegaUsd: 0, ...over });
  test("a buy that would pass a cap is blocked; EXTENDED halves the series and name caps", () => {
    expect(buyBlockReason(series(), market({ book: book({ seriesValueUsd: 19_000 }) }), 500)).toBeNull();
    expect(buyBlockReason(series(), market({ book: book({ seriesValueUsd: 19_900 }) }), 500)).toBe("CAP_REACHED");
    // EXTENDED: series cap 10000
    expect(buyBlockReason(series(), market({ session: "EXTENDED", book: book({ seriesValueUsd: 9_900 }) }), 500)).toBe("CAP_REACHED");
    expect(buyBlockReason(series(), market({ session: "EXTENDED", book: book({ seriesValueUsd: 9_000 }) }), 500)).toBeNull();
    // name cap 80000 -> 40000 in EXTENDED
    expect(buyBlockReason(series(), market({ book: book({ nameValueUsd: 70_000 }) }), 500)).toBeNull();
    expect(buyBlockReason(series(), market({ session: "EXTENDED", book: book({ nameValueUsd: 70_000 }) }), 500)).toBe("CAP_REACHED");
    // the total cap is not halved
    expect(buyBlockReason(series(), market({ session: "EXTENDED", book: book({ totalValueUsd: 340_000 }) }), 500)).toBeNull();
    expect(buyBlockReason(series(), market({ book: book({ totalValueUsd: 349_900 }) }), 500)).toBe("CAP_REACHED");
  });
  test("the dollar series cap applies when it is lower than 2% of NAV; no NAV blocks; no book state reports nothing", () => {
    expect(buyBlockReason(series(), market({ book: { navUsd: 10_000_000, nameVegaUsd: 0, seriesValueUsd: 39_900 } }), 500)).toBe("CAP_REACHED");
    expect(buyBlockReason(series(), market({ book: { navUsd: 0, nameVegaUsd: 0 } }), 1)).toBe("CAP_REACHED");
    expect(buyBlockReason(series(), market(), 1e12)).toBeNull();
  });
  test("a quote's buyable and blockReason include the cap on the quoted size", () => {
    const m = market({ book: book({ seriesValueUsd: 19_990 }) });
    expect(quoteUnits(series(), m, WAD, true)!.buyable).toBe(true);
    const big = quoteUnits(series(), m, 100n * WAD, true)!;
    expect(big.buyable).toBe(false);
    expect(big.buyBlock).toBe("CAP_REACHED");
    expect(quoteUnits(series(), m, 100n * WAD, false)!.sellQueued).toBe(false);
  });
});

describe("F01/F02/F10/F22/F23 trade price: worse of S and the trade TWAP, and the 30-minute hold (decision 30)", () => {
  const at = (s: number) => market({ spot: s });
  test("a call buy is priced at the higher of S and the TWAP, a call sell at the lower", () => {
    const up = quoteUnits(series(), market({ tradeTwap: 102 }), WAD, true)!;
    expect(up.usdg).toBe(quoteUnits(series(), at(102), WAD, true)!.usdg);
    expect(up.tradeSpot).toBe(102);
    // a TWAP better for the buyer is ignored
    expect(quoteUnits(series(), market({ tradeTwap: 98 }), WAD, true)!.usdg).toBe(quoteUnits(series(), market(), WAD, true)!.usdg);
    const down = quoteUnits(series(), market({ tradeTwap: 98 }), WAD, false)!;
    expect(down.usdg).toBe(quoteUnits(series(), at(98), WAD, false)!.usdg);
  });

  test("puts take the mirror image: a put buy at the lower S, a put sell at the higher", () => {
    const put = series({ isCall: false });
    expect(quoteUnits(put, market({ tradeTwap: 97 }), WAD, true)!.usdg).toBe(quoteUnits(put, at(97), WAD, true)!.usdg);
    expect(quoteUnits(put, market({ tradeTwap: 103 }), WAD, false)!.usdg).toBe(quoteUnits(put, at(103), WAD, false)!.usdg);
  });

  test("the fee is charged on the trade S and the valuation (caps, inventory) stays at the feed S", () => {
    const q = quoteUnits(series(), market({ tradeTwap: 110 }), WAD, true)!;
    expect(q.feeUsdg).toBe(33_000n);
    expect(q.sigmaBps).toBe(quoteUnits(series(), at(110), WAD, true)!.sigmaBps);
  });

  test("a sell inside the account's hold is priced at the worse of the trade S and the buy-time S; after it, not", () => {
    const hold = { s: 95, untilMs: 1_000_000 + 60_000 };
    const inside = quoteUnits(series(), market({ hold }), WAD, false)!;
    expect(inside.usdg).toBe(quoteUnits(series(), at(95), WAD, false)!.usdg);
    expect(inside.holdApplied).toBe(true);
    const after = quoteUnits(series(), market({ hold, nowMs: hold.untilMs }), WAD, false)!;
    expect(after.holdApplied).toBe(false);
    expect(after.usdg).toBe(quoteUnits(series(), market({ nowMs: hold.untilMs }), WAD, false)!.usdg);
    // a hold never touches a buy, and a buy-time S better for the seller is ignored
    expect(quoteUnits(series(), market({ hold }), WAD, true)!.usdg).toBe(quoteUnits(series(), market(), WAD, true)!.usdg);
    expect(quoteUnits(series(), market({ hold: { s: 105, untilMs: hold.untilMs } }), WAD, false)!.holdApplied).toBe(false);
  });

  test("R02 (28-merge): only the held units are priced at the hold's S; the rest at the trade S, as EngineCore.priceSell", () => {
    const untilMs = 1_000_000 + 60_000;
    const half = 5n * WAD / 10n;
    const split = quoteUnits(series(), market({ hold: { s: 95, untilMs, units: 0.5 } }), WAD, false)!;
    const heldPart = quoteUnits(series(), at(95), half, false)!;
    const freePart = quoteUnits(series(), market(), WAD - half, false)!;
    expect(split.usdg).toBe(heldPart.usdg + freePart.usdg);
    expect(split.feeUsdg).toBe(heldPart.feeUsdg + freePart.feeUsdg);
    expect(split.holdApplied).toBe(true);
    expect(split.tradeSpot).toBe(100); // the per-unit fields are the free part's (the engine's quote)
    // held units at or above the sale: all of it at the hold's S; none held: no hold
    expect(quoteUnits(series(), market({ hold: { s: 95, untilMs, units: 3 } }), WAD, false)!.usdg).toBe(quoteUnits(series(), at(95), WAD, false)!.usdg);
    const none = quoteUnits(series(), market({ hold: { s: 95, untilMs, units: 0 } }), WAD, false)!;
    expect(none.holdApplied).toBe(false);
    expect(none.usdg).toBe(quoteUnits(series(), market(), WAD, false)!.usdg);
    // PROPERTY: for any held share, the sell lies between the fully held and the free quote and grows as fewer are held
    let previous = -1n;
    for (let share = 1; share >= 0; share -= 0.05) {
      const q = quoteUnits(series(), market({ hold: { s: 95, untilMs, units: share } }), WAD, false)!.usdg;
      expect(q >= quoteUnits(series(), at(95), WAD, false)!.usdg - 1n && q <= quoteUnits(series(), market(), WAD, false)!.usdg + 1n).toBe(true);
      expect(q + 1n >= previous).toBe(true);
      previous = q;
    }
  });

  test("an ORC-4 settled stock quotes sells as CLOSED at the settlement price; buys stay blocked", () => {
    const settled = market({ session: "HALTED", spot: 90, settlePrice: 80 });
    const sell = quoteUnits(series(), settled, WAD, false)!;
    expect(sell.session).toBe("CLOSED");
    expect(sell.sellQueued).toBe(false);
    expect(sell.usdg).toBe(quoteUnits(series(), market({ session: "CLOSED", spot: 80 }), WAD, false)!.usdg);
    expect(quoteUnits(series(), settled, WAD, true)!.buyable).toBe(false);
  });
});
