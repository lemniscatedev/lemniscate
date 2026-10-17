// The simulated Writer Pool + Engine. Pricing, spreads, fees, session rules and buy blocks are the API quote model
// (api/quote/model.ts, QUOTE_PARAMS: the engine's canonical constants); funding is pricing/funding.ts; the rehedge
// decision is hedger/policy.ts. Caps and the stress budget are spec 4.2 / 2.5 / 10 (config LIMITS).
import { buyBlockReason, unitQuote, QUOTE_PARAMS, type MarketInputs, type SeriesInputs, type SessionName, type Speed, type BuyBlock } from "../api/quote/model";
import { callGreeks, callValue, fundingStep, putGreeks, putValue, TAU, YEAR_S } from "../pricing";
import { decideRehedge } from "../hedger/policy";
import { HEDGER_DEFAULTS, LIMITS } from "./defaults";
import { skewedSigma } from "./vol";
import type { Group, NameSpec } from "./types";

export interface NameCtx {
  spec: NameSpec;
  spot: number;
  session: SessionName;
  fresh: boolean;
  /** Base posted sigma (fraction) per speed, before skew. */
  sigma: Record<Speed, number>;
  hasVol: boolean;
  blockFromMs: number | null;
  blockToMs: number | null;
  /** The modelled TWAP cross-check is pausing buys (Scenario.twap). */
  twapPaused?: boolean;
  /** The modelled short trade TWAP (Scenario.tradeGuard), any session; undefined = not modelled or unavailable. */
  tradeTwap?: number;
}

export interface Series {
  key: string;
  name: string;
  isCall: boolean;
  strike: number;
  speed: Speed;
  norm: number;
  /** Outstanding option tokens; holder units = tokens x norm. */
  tokens: number;
}

export interface Position {
  id: number;
  account: string;
  group: Group;
  key: string;
  tokens: number;
  paid: number;
  sellAt: number;
  /** Trade S of the buy and when the minimum hold ends (Scenario.tradeGuard). */
  buyS?: number;
  holdUntil?: number;
}

export type BuyResult = { ok: true; positionId: number } | { ok: false; kind: "paused" | "cap"; reason: string };

const seriesKey = (name: string, isCall: boolean, strike: number, speed: Speed): string => `${name}|${isCall ? "C" : "P"}|${strike}|${speed}`;
const SHRINK = [1, 0.7, 0.45, 0.25, 0.1, 0.04] as const;

export class Pool {
  cash: number;
  shares: number;
  reserve = 0;
  readonly hedge = new Map<string, number>();
  readonly series = new Map<string, Series>();
  readonly positions = new Map<number, Position>();
  private readonly accountTokens = new Map<string, number>();
  private nextPosition = 1;
  nowSec = 0;
  /** Scenario.tradeGuard: hold length; undefined = the review fixes are not modelled. */
  holdS: number | undefined = undefined;
  readonly ctx = new Map<string, NameCtx>();
  buysPausedByDrawdown = false;
  readonly lastHedgeMs = new Map<string, number>();
  private stressCache = new Map<string, { up: number; down: number; m10: number }>();

  // statistics
  spreadIncome = 0;
  feeIncome = 0;
  fundingIncome = 0;
  hedgeCost = 0;
  sellShortfall = 0;
  hedgeTrades = 0;
  readonly hedgeVolume: Record<string, number> = {};
  buys = 0;
  sells = 0;
  readonly paused: Record<string, number> = {};
  readonly capBlocked: Record<string, number> = {};
  readonly pnl: Record<Group, number> = { retail: 0, gap: 0, earnings: 0 };

  constructor(initialNavUsd: number, private readonly hedgeEnabled: boolean, private readonly depthMult = 1) {
    this.cash = initialNavUsd;
    this.shares = initialNavUsd; // NAV per share starts at 1
  }

  // ---------- valuation ----------
  private sigmaFor(c: NameCtx, s: Series, spot: number): number {
    return skewedSigma(c.sigma[s.speed], s.strike, spot);
  }
  private valueAt(c: NameCtx, s: Series, spot: number): number {
    const sigma = this.sigmaFor(c, s, spot);
    const tau = TAU[s.speed] / YEAR_S;
    return s.isCall ? callValue(spot, s.strike, sigma, tau) : putValue(spot, s.strike, sigma, tau);
  }
  private greeksAt(c: NameCtx, s: Series) {
    const sigma = this.sigmaFor(c, s, c.spot);
    const tau = TAU[s.speed] / YEAR_S;
    return s.isCall ? callGreeks(c.spot, s.strike, sigma, tau) : putGreeks(c.spot, s.strike, sigma, tau);
  }
  private seriesOf(name: string): Series[] {
    const out: Series[] = [];
    for (const s of this.series.values()) if (s.name === name && s.tokens > 0) out.push(s);
    return out;
  }
  liabilityOfName(name: string, spot?: number): number {
    const c = this.ctx.get(name);
    if (!c) return 0;
    const at = spot ?? c.spot;
    let total = 0;
    for (const s of this.seriesOf(name)) total += s.tokens * s.norm * this.valueAt(c, s, at);
    return total;
  }
  optionValueOfName(name: string): number { return this.liabilityOfName(name); }
  totalLiability(): number {
    let total = 0;
    for (const name of this.ctx.keys()) total += this.liabilityOfName(name);
    return total;
  }
  hedgeValue(): number {
    let total = 0;
    for (const [name, units] of this.hedge) total += units * (this.ctx.get(name)?.spot ?? 0);
    return total;
  }
  equity(): number { return this.cash + this.hedgeValue() - this.totalLiability(); }
  navPerShare(): number { return this.shares > 0 ? this.equity() / this.shares : 0; }
  /** Equity if every hedge were sold now at fee plus full-size price impact. */
  liquidationEquity(): number {
    let hedge = 0;
    for (const [name, units] of this.hedge) {
      const c = this.ctx.get(name);
      if (!c || units <= 0) continue;
      const notional = units * c.spot;
      hedge += notional * (1 - c.spec.poolFeeBps / 10_000 - notional / (c.spec.poolDepthUsd * this.depthMult));
    }
    return this.cash + hedge - this.totalLiability();
  }

  /** The trade S (review F01/F02): worse for the trader of the feed spot and the modelled trade TWAP. */
  private tradeS(c: NameCtx, isCall: boolean, isBuy: boolean): number {
    if (this.holdS === undefined || c.tradeTwap === undefined) return c.spot;
    return isBuy === isCall ? Math.max(c.spot, c.tradeTwap) : Math.min(c.spot, c.tradeTwap);
  }

  // ---------- inputs ----------
  private seriesInputs(s: Series): SeriesInputs {
    return { isCall: s.isCall, speed: s.speed, strike: s.strike, buyable: true, archived: false };
  }
  private market(c: NameCtx, s: Series): MarketInputs {
    return {
      spot: c.spot, session: c.session, fresh: c.fresh, priceBuysPaused: c.twapPaused === true, engineBuysPaused: this.buysPausedByDrawdown,
      sigmaBps: c.hasVol ? this.sigmaFor(c, s, c.spot) * 10_000 : null, volStale: false,
      buyBlockFromMs: c.blockFromMs, buyBlockToMs: c.blockToMs, nowMs: this.nowSec * 1000,
    };
  }

  private getSeries(name: string, isCall: boolean, strike: number, speed: Speed): Series {
    const key = seriesKey(name, isCall, strike, speed);
    let s = this.series.get(key);
    if (!s) { s = { key, name, isCall, strike, speed, norm: 1, tokens: 0 }; this.series.set(key, s); }
    return s;
  }

  // ---------- funding ----------
  accrue(dtSec: number): void {
    for (const s of this.series.values()) {
      if (s.tokens <= 0) continue;
      const c = this.ctx.get(s.name);
      if (!c || !c.hasVol || !(c.spot > 0)) continue;
      const v = this.valueAt(c, s, c.spot);
      const payoff = Math.max(s.isCall ? c.spot - s.strike : s.strike - c.spot, 0);
      const before = s.norm;
      s.norm = fundingStep(s.norm, v, payoff, dtSec, TAU[s.speed]);
      this.fundingIncome += s.tokens * (before - s.norm) * v;
    }
    this.stressCache.clear();
  }

  // ---------- stress ----------
  private nameLoss(name: string, shock: number): number {
    const c = this.ctx.get(name);
    if (!c) return 0;
    const spot = c.spot * (1 + shock);
    const hedgeChange = (this.hedge.get(name) ?? 0) * c.spot * shock;
    const liabChange = this.liabilityOfName(name, spot) - this.liabilityOfName(name);
    return -(hedgeChange - liabChange); // positive = pool loses
  }
  private table(name: string) {
    let t = this.stressCache.get(name);
    if (!t) {
      t = {
        up: this.nameLoss(name, LIMITS.stressGap),
        down: this.nameLoss(name, -LIMITS.stressGap),
        m10: Math.max(this.nameLoss(name, LIMITS.stressOthers), this.nameLoss(name, -LIMITS.stressOthers)),
      };
      this.stressCache.set(name, t);
    }
    return t;
  }
  /** Worst loss, USD: a 25% gap in one name (worst direction) plus a 10% move in every other name (worst direction). */
  stressLoss(): number {
    const names = [...this.ctx.keys()].filter((n) => (this.ctx.get(n)?.spot ?? 0) > 0);
    let sumM10 = 0;
    for (const n of names) sumM10 += this.table(n).m10;
    let worst = 0;
    for (const n of names) {
      const t = this.table(n);
      worst = Math.max(worst, Math.max(t.up, t.down) + sumM10 - t.m10);
    }
    return worst;
  }
  invalidate(name: string): void { this.stressCache.delete(name); }

  // ---------- caps ----------
  private checkCaps(s: Series, account: string): string | null {
    const c = this.ctx.get(s.name)!;
    const scale = c.session === "EXTENDED" ? LIMITS.extendedCapScale : 1;
    const nav = this.equity();
    if (!(nav > 0)) return "nav_nonpositive";
    const seriesValue = s.tokens * s.norm * this.valueAt(c, s, c.spot);
    if (seriesValue > Math.min(LIMITS.perSeriesUsd, (LIMITS.perSeriesPctNav / 100) * nav) * scale) return "per_series";
    const acct = (this.accountTokens.get(`${account}|${s.key}`) ?? 0) * s.norm * this.valueAt(c, s, c.spot);
    if (acct > LIMITS.perAccountSeriesUsd * scale) return "per_account";
    let nameValue = 0, vega = 0, gamma = 0;
    for (const x of this.seriesOf(s.name)) {
      const units = x.tokens * x.norm;
      const g = this.greeksAt(c, x);
      nameValue += units * g.v;
      vega += units * g.vega;
      gamma += 0.5 * units * g.gamma * (0.01 * c.spot) ** 2;
    }
    if (nameValue > (LIMITS.perNamePctNav / 100) * nav * scale) return "per_name";
    if (vega > (LIMITS.vegaPctNavPerVolPoint / 100) * nav) return "vega";
    if (gamma > (LIMITS.gammaPctNavPer1PctMove / 100) * nav) return "gamma";
    if (this.totalLiability() > (LIMITS.totalOptionValuePctNav / 100) * nav) return "total_value";
    if (this.stressLoss() > (LIMITS.stressBudgetPctNav / 100) * nav) return "stress_budget";
    return null;
  }

  // ---------- trading ----------
  private bump(counter: Record<string, number>, key: string): void { counter[key] = (counter[key] ?? 0) + 1; }

  /** A buy of about `targetValueUsd` of option value (at the mark). Tries smaller sizes when a cap binds. */
  buy(account: string, group: Group, name: string, isCall: boolean, strike: number, speed: Speed, targetValueUsd: number, sellAt: number): BuyResult {
    const c = this.ctx.get(name);
    if (!c || !(c.spot > 0)) { this.bump(this.paused, "NO_PRICE"); return { ok: false, kind: "paused", reason: "NO_PRICE" }; }
    const s = this.getSeries(name, isCall, strike, speed);
    const inputs = this.seriesInputs(s);
    const market = this.market(c, s);
    const block: BuyBlock | null = buyBlockReason(inputs, market);
    if (block) { this.bump(this.paused, block); return { ok: false, kind: "paused", reason: block }; }
    const q = unitQuote(inputs, market, false)!;
    if (!(q.v > 0)) { this.bump(this.capBlocked, "zero_value"); return { ok: false, kind: "cap", reason: "zero_value" }; }
    // Review F01/F02: priced at the worse for the buyer of the feed and the trade TWAP (the mark stays at the feed).
    const sTrade = this.tradeS(c, isCall, true);
    const qTrade = sTrade === c.spot ? q : unitQuote(inputs, { ...market, spot: sTrade }, false)!;
    let lastReason = "cap";
    for (const f of SHRINK) {
      const units = (targetValueUsd * f) / q.v;
      if (units * q.askPerUnit < 5) break;
      const tokens = units / s.norm;
      s.tokens += tokens;
      const acctKey = `${account}|${s.key}`;
      this.accountTokens.set(acctKey, (this.accountTokens.get(acctKey) ?? 0) + tokens);
      // the buyer's USDG enters the pool before the caps look at NAV (cash + spread income, liability up by the mark)
      const askTotal = qTrade.askPerUnit * units;
      this.cash += askTotal;
      this.invalidate(name);
      const failed = this.checkCaps(s, account);
      if (failed) {
        s.tokens -= tokens;
        this.accountTokens.set(acctKey, (this.accountTokens.get(acctKey) ?? 0) - tokens);
        this.cash -= askTotal;
        this.invalidate(name);
        lastReason = failed;
        continue;
      }
      const fee = (QUOTE_PARAMS.feeBps / 10_000) * c.spot * units;
      const spread = (qTrade.askPerUnit - q.v) * units;
      this.spreadIncome += spread;
      this.feeIncome += fee;
      this.addReserve(spread);
      const id = this.nextPosition++;
      const hold = this.holdS === undefined ? {} : { buyS: sTrade, holdUntil: this.nowSec + this.holdS };
      this.positions.set(id, { id, account, group, key: s.key, tokens, paid: askTotal + fee, sellAt, ...hold });
      this.buys++;
      return { ok: true, positionId: id };
    }
    this.bump(this.capBlocked, lastReason);
    return { ok: false, kind: "cap", reason: lastReason };
  }

  private addReserve(spread: number): void {
    const room = Math.max(0, (LIMITS.reserveTargetPctNav / 100) * Math.max(this.equity(), 0) - this.reserve);
    this.reserve += Math.min(room, LIMITS.reserveSpreadShare * Math.max(spread, 0));
  }

  /** Sells are never refused: CLOSED/UNKNOWN price at the last print with the 3x spread and weekend sigma. */
  sell(positionId: number): void {
    const p = this.positions.get(positionId);
    if (!p) return;
    const s = this.series.get(p.key)!;
    const c = this.ctx.get(s.name)!;
    this.positions.delete(positionId);
    const units = p.tokens * s.norm;
    let received = 0;
    if (c.hasVol && c.spot > 0) {
      const q = unitQuote(this.seriesInputs(s), this.market(c, s), true)!;
      // Review F01/F02/F10/F22: the worse for the seller of the feed (or last close) and the trade TWAP, and inside
      // the hold also the buy S.
      let sTrade = this.tradeS(c, s.isCall, false);
      if (p.buyS !== undefined && p.holdUntil !== undefined && this.nowSec < p.holdUntil) {
        sTrade = s.isCall ? Math.min(sTrade, p.buyS) : Math.max(sTrade, p.buyS);
      }
      const qTrade = sTrade === c.spot ? q : unitQuote(this.seriesInputs(s), { ...this.market(c, s), spot: sTrade }, true)!;
      const fee = (QUOTE_PARAMS.feeBps / 10_000) * c.spot * units;
      const bidTotal = qTrade.bidPerUnit * units;
      this.ensureCash(bidTotal);
      const pay = Math.min(bidTotal, Math.max(this.cash, 0));
      this.sellShortfall += bidTotal - pay;
      this.cash -= pay;
      received = Math.max(pay - fee, 0);
      const spread = (q.v - qTrade.bidPerUnit) * units;
      this.spreadIncome += spread;
      this.feeIncome += fee;
      this.addReserve(spread);
    }
    s.tokens = Math.max(s.tokens - p.tokens, 0);
    const k = `${p.account}|${s.key}`;
    this.accountTokens.set(k, Math.max((this.accountTokens.get(k) ?? 0) - p.tokens, 0));
    this.pnl[p.group] += received - p.paid;
    this.sells++;
    this.invalidate(s.name);
  }

  /** Pool cash raising: sell hedge stock (any session) until `needed` cash is on hand. */
  private ensureCash(needed: number): void {
    if (this.cash >= needed) return;
    const order = [...this.hedge.entries()].filter(([, u]) => u > 0).sort((a, b) => b[1] * (this.ctx.get(b[0])?.spot ?? 0) - a[1] * (this.ctx.get(a[0])?.spot ?? 0));
    for (const [name, units] of order) {
      const c = this.ctx.get(name)!;
      const wantUsd = needed - this.cash;
      const sellUnits = Math.min(units, wantUsd / (c.spot * 0.99));
      this.trade(name, -sellUnits);
      if (this.cash >= needed) return;
    }
  }

  /** Hedge swap on the primary pool: execution at spot minus/plus fee and linear price impact (notional / pool depth). */
  private trade(name: string, deltaUnits: number): void {
    const c = this.ctx.get(name)!;
    const notional = Math.abs(deltaUnits) * c.spot;
    const friction = c.spec.poolFeeBps / 10_000 + notional / (c.spec.poolDepthUsd * this.depthMult);
    const cost = notional * friction;
    this.cash -= deltaUnits * c.spot + cost; // buy: pay spot + cost; sell: receive spot - cost
    this.hedge.set(name, (this.hedge.get(name) ?? 0) + deltaUnits);
    this.hedgeCost += cost;
    this.hedgeVolume[name] = (this.hedgeVolume[name] ?? 0) + notional;
    this.hedgeTrades++;
    this.lastHedgeMs.set(name, this.nowSec * 1000);
    this.invalidate(name);
  }

  // ---------- hedging ----------
  netDeltaUnits(name: string): number {
    const c = this.ctx.get(name);
    if (!c || !c.hasVol) return 0;
    let delta = 0;
    for (const s of this.seriesOf(name)) delta += s.tokens * s.norm * this.greeksAt(c, s).delta;
    return delta;
  }

  rehedge(name: string): void {
    if (!this.hedgeEnabled) return;
    const c = this.ctx.get(name);
    if (!c || !(c.spot > 0) || !c.hasVol) return;
    const target = Math.max(0, this.netDeltaUnits(name)); // spot cannot be short
    const current = this.hedge.get(name) ?? 0;
    const gap = target - current;
    const decision = decideRehedge({
      gapUnits: gap, spot: c.spot, navUsdg: this.equity(), session: c.session, inputsFresh: c.fresh, nowMs: this.nowSec * 1000,
      lastTradeMs: this.lastHedgeMs.get(name), bandBps: HEDGER_DEFAULTS.bandBps, intervalSeconds: HEDGER_DEFAULTS.intervalSeconds,
      cooldownSeconds: HEDGER_DEFAULTS.cooldownSeconds, minTradeUsdg: HEDGER_DEFAULTS.minTradeUsdg,
    });
    if (!decision.trade) return;
    const maxNotional = (HEDGER_DEFAULTS.maxLiquidityBps / 10_000) * (c.spec.poolDepthUsd * this.depthMult);
    // slippage cap (HEDGER_MAX_SLIPPAGE_BPS): impact = notional / depth, so a thin pool limits the trade size
    const slippageNotional = ((HEDGER_DEFAULTS.maxSlippageBps / 10_000) * c.spec.poolDepthUsd * this.depthMult);
    let notional = Math.min(Math.abs(gap) * c.spot, maxNotional, slippageNotional);
    if (gap > 0) notional = Math.min(notional, Math.max(this.cash, 0) * 0.98 / (1 + c.spec.poolFeeBps / 10_000 + notional / (c.spec.poolDepthUsd * this.depthMult)));
    if (notional < HEDGER_DEFAULTS.minTradeUsdg) return;
    this.trade(name, Math.sign(gap) * (notional / c.spot));
  }

  // ---------- LP flows ----------
  deposit(amountUsd: number): boolean {
    const nav = this.equity();
    if (!(nav > 0) || nav + amountUsd > LIMITS.poolNavCapUsd) return false;
    const navps = this.navPerShare();
    this.shares += amountUsd / (navps * (1 + LIMITS.depositEntryBps / 10_000));
    this.cash += amountUsd;
    return true;
  }
  withdraw(fractionOfShares: number): boolean {
    const nav = this.equity();
    const amount = fractionOfShares * nav;
    if (!(nav > 0) || this.cash < amount * 1.5) return false;
    this.cash -= amount;
    this.shares *= 1 - fractionOfShares;
    return true;
  }

  /** Mark of open positions at today's bid, for group P&L at the end of a run. */
  markOpenPositions(): void {
    for (const id of [...this.positions.keys()]) {
      const p = this.positions.get(id)!;
      const s = this.series.get(p.key)!;
      const c = this.ctx.get(s.name);
      if (!c || !c.hasVol || !(c.spot > 0)) continue;
      const q = unitQuote(this.seriesInputs(s), this.market(c, s), true)!;
      const units = p.tokens * s.norm;
      this.pnl[p.group] += Math.max(q.bidPerUnit * units - (QUOTE_PARAMS.feeBps / 10_000) * c.spot * units, 0) - p.paid;
    }
  }
}
