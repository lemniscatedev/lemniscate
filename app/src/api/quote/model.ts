// The API's quote model: the engine's pricing rules in TypeScript, computed from indexed state (latest price tick,
// latest vol post, series norm, pool NAV and name vega). It mirrors IOptionEngine.Quote field for field and follows
// EngineHelper.price / sigmaFor / EngineCore.priceTrade (todo 07, decision 17 and "Canonical quote parameters"):
//   sigma(K)  = floor(sigmaBps x (1 + kPut max(0, -ln K/S) + kCall max(0, ln K/S))), skewK as posted, clamped to
//               [1000, 30000] bps; a stale vol post prices SELLS at sigma x 0.8 (review F09/F13: a multiplier on the
//               skewed sigma, so a vol-engine lapse lowers the bid, never raises it).
//   V_mark    = V(sigma) x (1 + 0.15 n), n = post-trade name vega / (0.6% of NAV), clamped to [0, 1].
//   spread    = max($0.01, V_mark x (150 + 250 min(|K/S-1|/0.3, 1)) bps x session factor); fee 3 bps of S x units.
// The inventory term needs the pool NAV and the name's net vega. Both come from the indexer (pool_nav, limits_state),
// which snapshots on every trade and at least every 10 minutes, so the term can be a few minutes stale; a quote taken
// between snapshots can differ from the chain by (0.15 x change in n) x V. Without that state `n` is 0 and the quote
// says so (`inventoryApplied: false`). The engine decides the final numbers on chain; slippage bounds absorb the gap.
import { TAU, YEAR_S, callGreeks, callValue, fundingRate, fundingStep, putGreeks, putValue, type Greeks } from "../../pricing";

export type SessionName = "REGULAR" | "EXTENDED" | "CLOSED" | "UNKNOWN" | "HALTED";
export type Speed = "DAILY" | "WEEKLY";

export const QUOTE_PARAMS = {
  /** Notional fee: bps of S x units, charged on buys and sells. */
  feeBps: 3,
  /** Smallest spread per option unit, USDG. */
  minSpreadUsd: 0.01,
  /** Spread at the money and at or beyond `farMoneyness`, bps of the mark (1.5% to 4%). */
  spreadBpsAtm: 150,
  spreadBpsFar: 400,
  /** |K/S - 1| at which the spread reaches its far value. */
  farMoneyness: 0.3,
  /** Session spread multipliers (REGULAR 1x, EXTENDED 1.5x, CLOSED and UNKNOWN 3x). */
  sessionMultiplier: { REGULAR: 1, EXTENDED: 1.5, CLOSED: 3, UNKNOWN: 3, HALTED: 3 } satisfies Record<SessionName, number>,
  /** A stale vol post prices sells at the skewed sigma x 0.8 (EngineHelper.valueAt, Params.staleVolCutBps). */
  staleVolSellCutBps: 2_000,
  /** Inventory mark-up a = 0.15 at n = 1. */
  inventoryBps: 1_500,
  /** n reaches 1 when the post-trade name vega equals this share of NAV per vol point (0.6%). */
  vegaCapNavBps: 60,
  /** The pricing library's sigma domain, bps. */
  minSigmaBps: 1_000,
  maxSigmaBps: 30_000,
  /** Buy caps (decision 6): per series min(USD cap, share of NAV), per name and total shares of NAV. */
  seriesCapUsd: 40_000,
  seriesCapNavBps: 200,
  nameCapNavBps: 800,
  totalCapNavBps: 3_500,
  /** EXTENDED session: series, account and name caps are halved. */
  extendedCapBps: 5_000,
  /** Funding is quoted over one calendar day. */
  fundingDaySeconds: 86_400,
} as const;

export const TAU_SECONDS: Record<Speed, number> = { DAILY: TAU.DAILY, WEEKLY: TAU.WEEKLY };

export interface MarketInputs {
  /** Underlying price, USDG per whole Stock Token. */
  readonly spot: number;
  readonly session: SessionName;
  /** Feed within its allowed age and the issuer oracle running. */
  readonly fresh: boolean;
  /** PriceGuard buy pause (pending multiplier change, continuity failure). */
  readonly priceBuysPaused: boolean;
  /** Engine-level pause: global or this series. */
  readonly engineBuysPaused: boolean;
  /** Posted sigma for the series speed; null when nothing was ever posted. */
  readonly sigmaBps: number | null;
  /** The vol post's packed skew, (kPut x 1e4) << 32 | kCall x 1e4 (decision 17). Absent or 0n means no skew. */
  readonly skewK?: bigint;
  readonly volStale: boolean;
  /** Earnings buy-block window as unix milliseconds, or null. */
  readonly buyBlockFromMs: number | null;
  readonly buyBlockToMs: number | null;
  readonly nowMs: number;
  /** Pool and book state from the indexer. Absent: the inventory term is off and caps are not checked. */
  readonly book?: BookInputs;
  /** PriceGuard.tradeTwap (USDG per token): the short-window pool TWAP every trade is also priced at, worse for the
   * trader (decision 30). Absent, null or 0: unavailable, the feed S alone prices the trade (as the engine does). */
  readonly tradeTwap?: number | null;
  /** The account's open hold on this series (engine.holdOf): a sell before `untilMs` is priced at the worse of the trade
   * S and the buy-time `s` (decision 30). Only sells of that account carry it. */
  readonly hold?: { readonly s: number; readonly untilMs: number } | null;
  /** engine.settlePrice: an ORC-4 settled stock (decision 31) reads CLOSED at this price while its feed is HALTED. */
  readonly settlePrice?: number | null;
}

/** EngineCore.settled: a HALTED stock with an ORC-4 settlement price reads CLOSED at that price (fresh, buys paused),
 * so sells and queued fills go through instead of waiting for a feed that is gone. */
export function effectiveMarket(market: MarketInputs): MarketInputs {
  if (market.session !== "HALTED" || !(Number(market.settlePrice) > 0)) return market;
  return { ...market, session: "CLOSED", spot: Number(market.settlePrice), fresh: true, priceBuysPaused: true };
}

/** EngineCore.tradeS: the S a trade is priced at. The worse for the trader of the feed S and the trade TWAP, and for a
 * sell inside the account's hold also the buy-time S. The trader is worse off at a higher S when isBuy == isCall. */
export function tradeSpot(series: Pick<SeriesInputs, "isCall">, market: MarketInputs, isBuy: boolean): { s: number; holdApplied: boolean } {
  const up = isBuy === series.isCall;
  const worse = (a: number, b: number) => (up ? Math.max(a, b) : Math.min(a, b));
  let s = market.spot;
  const twap = Number(market.tradeTwap ?? 0);
  if (twap > 0) s = worse(s, twap);
  let holdApplied = false;
  if (!isBuy && market.hold && market.hold.untilMs > market.nowMs && market.hold.s > 0) {
    const held = worse(s, market.hold.s);
    holdApplied = held !== s;
    s = held;
  }
  return { s, holdApplied };
}

/** Indexed pool and book state (pool_nav, limits_state, the transfer ledger), all USDG. */
export interface BookInputs {
  /** Pool NAV, USDG. */
  readonly navUsd: number;
  /** The name's outstanding vega (holders' long side, USDG per vol point): limits_state.net_vega. */
  readonly nameVegaUsd: number;
  /** Outstanding option value of this series, of its name, and of the whole book. */
  readonly seriesValueUsd?: number;
  readonly nameValueUsd?: number;
  readonly totalValueUsd?: number;
}

export interface SeriesInputs {
  readonly isCall: boolean;
  readonly speed: Speed;
  /** Strike, USDG per whole Stock Token. */
  readonly strike: number;
  readonly buyable: boolean;
  readonly archived: boolean;
}

export type BuyBlock =
  | "SERIES_ARCHIVED" | "SERIES_NOT_BUYABLE" | "BUYS_PAUSED" | "SESSION_CLOSED" | "SESSION_UNKNOWN" | "SESSION_HALTED"
  | "PRICE_STALE" | "PRICE_PAUSED" | "NO_VOL" | "VOL_STALE" | "EARNINGS_BLOCK" | "NO_PRICE" | "CAP_REACHED";

/** True when buying `addedValueUsd` more would pass a series, name or total cap. EXTENDED halves the series and name
 * caps (spec 4.3). Needs `market.book`; without it nothing is reported (the chain still enforces the caps). */
export function capReached(market: MarketInputs, addedValueUsd: number): boolean {
  const book = market.book;
  if (!book) return false;
  if (!(book.navUsd > 0)) return true;
  const factor = market.session === "EXTENDED" ? QUOTE_PARAMS.extendedCapBps / 10_000 : 1;
  const seriesCap = Math.min(QUOTE_PARAMS.seriesCapUsd, (book.navUsd * QUOTE_PARAMS.seriesCapNavBps) / 10_000) * factor;
  const nameCap = ((book.navUsd * QUOTE_PARAMS.nameCapNavBps) / 10_000) * factor;
  const totalCap = (book.navUsd * QUOTE_PARAMS.totalCapNavBps) / 10_000;
  if (book.seriesValueUsd !== undefined && book.seriesValueUsd + addedValueUsd > seriesCap) return true;
  if (book.nameValueUsd !== undefined && book.nameValueUsd + addedValueUsd > nameCap) return true;
  if (book.totalValueUsd !== undefined && book.totalValueUsd + addedValueUsd > totalCap) return true;
  return false;
}

/** Why a buy of `addedValueUsd` of option value would be refused right now, or null when it is allowed. First match
 * wins; the order is the engine's (EngineCore.buyBlock), then the caps (EngineHelper.checkCaps). */
export function buyBlockReason(series: SeriesInputs, raw: MarketInputs, addedValueUsd = 0): BuyBlock | null {
  const market = effectiveMarket(raw);
  if (!(market.spot > 0)) return "NO_PRICE";
  if (series.archived) return "SERIES_ARCHIVED";
  if (!series.buyable) return "SERIES_NOT_BUYABLE";
  if (market.engineBuysPaused) return "BUYS_PAUSED";
  if (market.session === "HALTED") return "SESSION_HALTED";
  if (market.session === "CLOSED") return "SESSION_CLOSED";
  if (market.session === "UNKNOWN") return "SESSION_UNKNOWN";
  if (!market.fresh) return "PRICE_STALE";
  if (market.priceBuysPaused) return "PRICE_PAUSED";
  if (market.sigmaBps === null) return "NO_VOL";
  if (market.volStale) return "VOL_STALE";
  if (market.buyBlockFromMs !== null && market.buyBlockToMs !== null
    && market.nowMs >= market.buyBlockFromMs && market.nowMs <= market.buyBlockToMs) return "EARNINGS_BLOCK";
  if (capReached(market, addedValueUsd)) return "CAP_REACHED";
  return null;
}

const SKEW_MASK = 0xffff_ffffn;

/** Sigma in bps the engine prices strike K at: skewed by the posted skewK, floored to whole bps and clamped to the
 * pricing domain (EngineHelper.sigmaFor), then optionally cut (stale-vol sells: x (1 - cut), floored, EngineHelper.valueAt). */
export function skewedSigmaBps(sigmaBps: number, skewK: bigint | undefined, strike: number, spot: number, cut = 0): number {
  const skewed = skewSigma(sigmaBps, skewK, strike, spot);
  if (cut === 0) return skewed;
  return Math.max(Math.floor((skewed * (10_000 - cut)) / 10_000), QUOTE_PARAMS.minSigmaBps);
}

function skewSigma(sigmaBps: number, skewK: bigint | undefined, strike: number, spot: number): number {
  let sig = sigmaBps;
  const kPut = Number(((skewK ?? 0n) >> 32n) & SKEW_MASK);
  const kCall = Number((skewK ?? 0n) & SKEW_MASK);
  if (kPut !== 0 || kCall !== 0) {
    const l = Math.log(strike / spot);
    const add = l < 0 ? (kPut / 10_000) * -l : (kCall / 10_000) * l;
    sig = Math.floor(sig * (1 + add) + 1e-9);
  }
  return Math.min(Math.max(sig, QUOTE_PARAMS.minSigmaBps), QUOTE_PARAMS.maxSigmaBps);
}

/** n in [0, 1]: post-trade name vega over the vega cap (0.6% of NAV). 1 when NAV is not positive. */
export function inventoryN(book: BookInputs, tradeVegaUsd: number): number {
  if (!(book.navUsd > 0)) return 1;
  const cap = (book.navUsd * QUOTE_PARAMS.vegaCapNavBps) / 10_000;
  const after = Math.max(book.nameVegaUsd + tradeVegaUsd, 0);
  return Math.min(after / cap, 1);
}

/** Spread as bps of the mark before the minimum: 1.5% at the money rising to 4% at 30% away, times the session factor. */
export function spreadBpsFor(strike: number, spot: number, session: SessionName): number {
  const away = Math.min(Math.abs(strike / spot - 1) / QUOTE_PARAMS.farMoneyness, 1);
  const base = QUOTE_PARAMS.spreadBpsAtm + (QUOTE_PARAMS.spreadBpsFar - QUOTE_PARAMS.spreadBpsAtm) * away;
  return base * QUOTE_PARAMS.sessionMultiplier[session];
}

export interface UnitQuote {
  /** Valuation mark per unit: V at the skewed sigma, no stale bump, no inventory term (the liability mark). */
  readonly v: number;
  /** Priced mark per unit, before spread: bumped sigma for stale-vol sells, times (1 + 0.15 n). IOptionEngine.Quote.vMarkWad. */
  readonly vMark: number;
  readonly payoff: number;
  /** The sigma priced, bps (skewed, bumped for stale-vol sells, clamped). IOptionEngine.Quote.sigmaBps. */
  readonly sigmaBps: number;
  readonly sigmaUsed: number;
  /** Inventory n in [0, 1]. */
  readonly inventory: number;
  /** False when no pool/book state was available, so n = 0 by assumption. */
  readonly inventoryApplied: boolean;
  readonly spreadBps: number;
  readonly spreadPerUnit: number;
  readonly askPerUnit: number;
  readonly bidPerUnit: number;
  /** Greeks at the skewed, unbumped sigma (what the engine's risk book uses). */
  readonly greeks: Greeks;
  /** Share of the priced mark that funding takes per calendar day at today's state: fundingRate x 86400 / tau. */
  readonly dayFundingFraction: number;
  /** The priced per-unit value before the inventory term (the mark funding is charged on). */
  readonly vPrice: number;
}

/** Per-unit numbers for one series. `forSell` applies the stale-vol sigma cut (x 0.8); `units` sizes the trade for the
 * inventory term (the engine uses the post-trade name vega). `sTrade` (EngineCore.priceTrade) prices the trade at that S
 * (sigma skew, value, payoff and spread at sTrade) while the valuation mark, Greeks and inventory stay at the feed S. */
export function unitQuote(series: SeriesInputs, raw: MarketInputs, forSell: boolean, units = 0, sTrade?: number): UnitQuote | null {
  const market = effectiveMarket(raw);
  if (market.sigmaBps === null || !(market.spot > 0) || !(series.strike > 0)) return null;
  const sT = sTrade !== undefined && sTrade > 0 ? sTrade : market.spot;
  const tau = TAU_SECONDS[series.speed];
  const tauYears = tau / YEAR_S;
  const valueAt = (sigmaBps: number, s: number): number => {
    const sigma = sigmaBps / 10_000;
    return series.isCall ? callValue(s, series.strike, sigma, tauYears) : putValue(s, series.strike, sigma, tauYears);
  };
  const sigmaBase = skewedSigmaBps(market.sigmaBps, market.skewK, series.strike, market.spot);
  const greeks = series.isCall
    ? callGreeks(market.spot, series.strike, sigmaBase / 10_000, tauYears)
    : putGreeks(market.spot, series.strike, sigmaBase / 10_000, tauYears);
  const v = greeks.v;
  const bumped = forSell && market.volStale;
  const repriced = bumped || sT !== market.spot;
  const sigmaBps = repriced
    ? skewedSigmaBps(market.sigmaBps, market.skewK, series.strike, sT, bumped ? QUOTE_PARAMS.staleVolSellCutBps : 0)
    : sigmaBase;
  const vPrice = repriced ? valueAt(sigmaBps, sT) : v;
  const payoff = Math.max(series.isCall ? sT - series.strike : series.strike - sT, 0);
  const inventoryApplied = market.book !== undefined;
  const inventory = market.book ? inventoryN(market.book, (forSell ? -1 : 1) * units * greeks.vega) : 0;
  const vMark = vPrice * (1 + (QUOTE_PARAMS.inventoryBps / 10_000) * inventory);
  const spreadBps = spreadBpsFor(series.strike, sT, market.session);
  const spreadPerUnit = Math.max(QUOTE_PARAMS.minSpreadUsd, (vMark * spreadBps) / 10_000);
  // The funding rate of spec 1.4, f = (V - payoff) / tau per unit of time, over one calendar day. It is the first-order
  // limit of fundingStep (units shrink by rate x dt / tau), so "costs about $X a day" matches the overview example
  // (Weekly, S = K = 100, sigma 50%: $2.45 mark, about $0.35 a day). The realised cost over a full day is a little
  // lower because the units shrink while they are being charged. The engine charges it on the priced value before the
  // inventory term.
  const dayFundingFraction = (fundingRate(vPrice, payoff) * QUOTE_PARAMS.fundingDaySeconds) / tau;
  return {
    v, vMark, vPrice, payoff, sigmaBps, sigmaUsed: sigmaBps / 10_000, inventory, inventoryApplied, spreadBps, spreadPerUnit,
    askPerUnit: vMark + spreadPerUnit, bidPerUnit: Math.max(vMark - spreadPerUnit, 0), greeks, dayFundingFraction,
  };
}

const MICRO = 1_000_000;
const toMicroUp = (usd: number): bigint => BigInt(Math.max(0, Math.ceil(usd * MICRO - 1e-9)));
const toMicroDown = (usd: number): bigint => BigInt(Math.max(0, Math.floor(usd * MICRO + 1e-9)));
const WAD = 10n ** 18n;

export interface EngineQuote {
  /** USDG, 6 dp: ask (rounded up) for buys, bid (rounded down) for sells, fee included. */
  readonly usdg: bigint;
  readonly vMarkWad: bigint;
  readonly spreadBps: number;
  readonly feeUsdg: bigint;
  /** Today's holding cost for these units, USDG 6 dp. */
  readonly dailyCostUsdg: bigint;
  /** Underlying price at which the option has paid for itself, WAD. */
  readonly breakevenWad: bigint;
  readonly sigmaBps: number;
  /** Inventory n in [0, 1] used in the mark, and whether pool/book state was available to compute it. */
  readonly inventory: number;
  readonly inventoryApplied: boolean;
  readonly session: SessionName;
  readonly buyable: boolean;
  readonly buyBlock: BuyBlock | null;
  /** True when a sell would be queued for a fresh price (HALTED session). */
  readonly sellQueued: boolean;
  /** The S the trade is priced at (EngineCore.tradeS): the feed S, the trade TWAP or the hold's buy-time S. */
  readonly tradeSpot: number;
  /** True when the account's hold (a sell within the hold after its buy) set a worse S than the trade TWAP rule. */
  readonly holdApplied: boolean;
}

const wadOf = (value: number): bigint => (Number.isFinite(value) && value > 0 ? BigInt(Math.round(value * 1e12)) * 10n ** 6n : 0n);

/** The quote for `unitsWad` option units (WAD), shaped like IOptionEngine.Quote. Null when no vol was ever posted. */
export function quoteUnits(series: SeriesInputs, raw: MarketInputs, unitsWad: bigint, isBuy: boolean): EngineQuote | null {
  const market = effectiveMarket(raw);
  const units = Number(unitsWad) / 1e18;
  const trade = tradeSpot(series, market, isBuy);
  const unit = unitQuote(series, market, !isBuy, units, trade.s);
  if (!unit) return null;
  const feeUsd = (QUOTE_PARAMS.feeBps / 10_000) * trade.s * units;
  const feeUsdg = toMicroUp(feeUsd);
  const allInAsk = unit.askPerUnit + feeUsd / (units || 1);
  const usdg = isBuy
    ? toMicroUp(unit.askPerUnit * units + feeUsd)
    : toMicroDown(unit.bidPerUnit * units - feeUsd);
  const breakeven = series.isCall ? series.strike + allInAsk : Math.max(series.strike - allInAsk, 0);
  const buyBlock = buyBlockReason(series, market, unit.v * units);
  return {
    usdg,
    vMarkWad: wadOf(unit.vMark),
    // The percentage spread applied to the mark; the one-cent minimum can lift the effective spread above it.
    spreadBps: Math.round(unit.spreadBps),
    feeUsdg,
    dailyCostUsdg: toMicroUp(unit.vPrice * unit.dayFundingFraction * units),
    breakevenWad: wadOf(breakeven),
    sigmaBps: unit.sigmaBps,
    inventory: unit.inventory,
    inventoryApplied: unit.inventoryApplied,
    session: market.session,
    buyable: buyBlock === null,
    buyBlock,
    sellQueued: !isBuy && market.session === "HALTED",
    tradeSpot: trade.s,
    holdApplied: trade.holdApplied,
  };
}

/** USDG 6 dp bigint to a decimal string. */
export function usdgText(value: bigint): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** WAD bigint to a decimal string without trailing zeros beyond 6 dp. */
export function wadText(value: bigint, places = 6): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const scale = 10n ** BigInt(18 - places);
  const rounded = abs / scale;
  const whole = rounded / 10n ** BigInt(places);
  const frac = (rounded % 10n ** BigInt(places)).toString().padStart(places, "0");
  return `${negative ? "-" : ""}${whole}.${frac}`;
}

/** Parse a positive decimal string into WAD, or null when malformed, zero or over 18 dp. */
export function parseWad(text: string): bigint | null {
  const match = /^(\d{1,18})(?:\.(\d{1,18}))?$/.exec(text);
  if (!match) return null;
  const value = BigInt(match[1]!) * WAD + BigInt((match[2] ?? "").padEnd(18, "0"));
  return value > 0n ? value : null;
}

/** "costs about $0.35/day". Copy rule: states a cost, never a return. */
export function displayCost(dailyCostUsdg: bigint): string {
  if (dailyCostUsdg === 0n) return "costs less than $0.01/day";
  if (dailyCostUsdg < 5_000n) return "costs less than $0.01/day";
  const cents = (dailyCostUsdg + 5_000n) / 10_000n;
  return `costs about $${cents / 100n}.${(cents % 100n).toString().padStart(2, "0")}/day`;
}

/** A stored USDG decimal string ("12.345678", may carry more places) to 6 dp bigint, truncating. */
export function usdgMicro(text: string): bigint {
  const match = /^(-?)(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) return 0n;
  const value = BigInt(match[2]!) * 1_000_000n + BigInt((match[3] ?? "").padEnd(6, "0").slice(0, 6));
  return match[1] ? -value : value;
}

/** Decimal string with up to 18+ places to WAD, truncating; zero and malformed input give 0n. */
export function looseWad(text: string): bigint {
  const match = /^(\d+)(?:\.(\d*))?$/.exec(text);
  if (!match) return 0n;
  return BigInt(match[1]!) * WAD + BigInt((match[2] ?? "").padEnd(18, "0").slice(0, 18));
}

/** The series' norm with funding applied from its last indexed accrual up to `market.nowMs`. The engine accrues a series
 * before every trade and the keeper only re-marks it hourly, so the indexed norm can be up to an hour old: a sell intent
 * priced with it burned too few tokens for the units asked and reverted on Slippage (todo 23 fork run), and positions
 * showed units the holder no longer had. Uses the liability mark V and payoff at the current price, as the engine's
 * accrual does at the start of a step. */
export function projectedNorm(series: SeriesInputs, market: MarketInputs, norm: number, lastAccrualMs: number): number {
  const dt = (market.nowMs - lastAccrualMs) / 1000;
  if (!(dt > 0) || !(norm > 0)) return norm;
  const unit = unitQuote(series, market, false);
  if (!unit || !(unit.v > 0)) return norm;
  return fundingStep(norm, unit.v, unit.payoff, dt, TAU_SECONDS[series.speed]);
}

/** A norm as an 18-decimal string, rounded down (a smaller norm burns at least the tokens the units need). */
export function normDecimal(norm: number): string {
  const wad = BigInt(Math.floor(norm * 1e18));
  const whole = wad / WAD;
  return `${whole}.${(wad % WAD).toString().padStart(18, "0")}`;
}
