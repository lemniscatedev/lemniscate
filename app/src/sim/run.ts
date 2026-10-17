import { TAU } from "../pricing";
import type { Speed } from "../api/quote/model";
import { LIMITS } from "./defaults";
import { Pool, type NameCtx } from "./pool";
import { injectGap, PricePath, scaleGaps } from "./prices";
import { Rng } from "./rng";
import { isBuyableSession, sessionAt } from "./sessions";
import { ETFS, type EarningsEvent, type Group, type RunResult, type SimConfig } from "./types";
import { VolState } from "./vol";

const HOUR = 3600;
const DAY = 86400;
const FRESH_MAX_AGE = 26 * HOUR;

interface Job {
  group: Group;
  name: string;
  isCall: boolean;
  jumpT: number;
  /** Last moment before which the adversary must already hold the position (jump print, or the earnings block). */
  entryBefore: number;
  state: "pending" | "open" | "done";
}

/** First Monday 13:30 UTC (regular open) at or after tSec. */
function firstMondayOpen(tSec: number): number {
  let t = Math.ceil(tSec / DAY) * DAY + 13.5 * HOUR;
  while (new Date(t * 1000).getUTCDay() !== 1) t += DAY;
  return t;
}

const iso = (t: number): string => new Date(t * 1000).toISOString();

function blockWindow(events: readonly EarningsEvent[], name: string, nowSec: number): [number | null, number | null] {
  for (const e of events) {
    if (e.name !== name) continue;
    const dayStart = Math.floor(e.tSec / DAY) * DAY;
    const from = dayStart;
    const to = dayStart + DAY + 14 * HOUR;
    if (nowSec >= from - 3 * DAY && nowSec <= to) return [from * 1000, to * 1000];
  }
  return [null, null];
}

/** Largest single-print moves per name inside the window, the adversary's "known gaps". */
function buildJobs(cfg: SimConfig, paths: Map<string, PricePath>, endSec: number): Job[] {
  const jobs: Job[] = [];
  for (const spec of cfg.names) {
    const path = paths.get(spec.name);
    if (!path) continue;
    const threshold = ETFS.has(spec.name) ? cfg.jumpThresholdEtf : cfg.jumpThresholdSingle;
    // "Known gaps": the largest net moves over any 2 hour run of prints (the feed prints overnight gaps in small steps, so
    // a single print is rarely large). Greedy, non-overlapping, top 6 per name.
    const moves: { start: number; end: number; r: number }[] = [];
    const pr = path.prints;
    for (let i = 1; i < pr.length; i++) {
      if (pr[i]!.t <= cfg.startSec + DAY || pr[i]!.t >= endSec) continue;
      let j = i;
      while (j + 1 < pr.length && pr[j + 1]!.t <= pr[i]!.t + 2 * HOUR) j++;
      const r = Math.log(pr[j]!.p / pr[i - 1]!.p);
      if (Math.abs(r) >= threshold) moves.push({ start: pr[i]!.t, end: pr[j]!.t, r });
    }
    moves.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
    const taken: typeof moves = [];
    for (const m of moves) {
      if (taken.length >= 6) break;
      if (taken.some((x) => m.start < x.end + 2 * HOUR && m.end > x.start - 2 * HOUR)) continue;
      taken.push(m);
      jobs.push({ group: "gap", name: spec.name, isCall: m.r > 0, jumpT: m.end, entryBefore: m.start, state: "pending" });
    }
    for (const e of cfg.earnings.filter((x) => x.name === spec.name && x.tSec > cfg.startSec + DAY && x.tSec < endSec)) {
      const window = path.prints.filter((p, i) => i > 0 && p.t >= e.tSec && p.t <= e.tSec + 2 * DAY).map((p) => ({ t: p.t, r: Math.log(p.p / path.prints[path.prints.indexOf(p) - 1]!.p) }));
      if (window.length === 0) continue;
      const big = window.reduce((a, b) => (Math.abs(b.r) > Math.abs(a.r) ? b : a));
      const blockFrom = Math.floor(e.tSec / DAY) * DAY;
      jobs.push({ group: "earnings", name: spec.name, isCall: big.r > 0, jumpT: big.t, entryBefore: blockFrom, state: "pending" });
    }
  }
  return jobs;
}

/** Modelled Uniswap TWAP over [t - windowS, t] of a pool price that leads the feed by leadS (one-minute samples). */
export function modelTwap(path: PricePath, t: number, windowS: number, leadS: number): number | null {
  let sum = 0;
  let n = 0;
  for (let u = t - windowS; u <= t; u += 60) {
    const pt = path.at(u + leadS);
    if (!pt) continue;
    sum += pt.p;
    n++;
  }
  return n ? sum / n : null;
}

export function runSim(cfg: SimConfig, rawPaths: Map<string, PricePath>, dataNotes: string[] = []): RunResult {
  const endSec = cfg.startSec + cfg.days * DAY;
  const paths = new Map<string, PricePath>();
  for (const spec of cfg.names) {
    const p = rawPaths.get(spec.name);
    if (!p) continue;
    let q = scaleGaps(p, cfg.scenario.gapMult);
    if (cfg.scenario.weekendGap !== 0) q = injectGap(q, firstMondayOpen(cfg.startSec + 7 * DAY), cfg.scenario.weekendGap * (ETFS.has(spec.name) ? 0.5 : 1));
    paths.set(spec.name, q);
  }
  const rng = new Rng(cfg.seed);
  const pool = new Pool(cfg.initialNavUsd, cfg.scenario.hedge, cfg.scenario.depthMult);
  const vols = new Map<string, VolState>();
  for (const spec of cfg.names) {
    if (!paths.has(spec.name)) continue;
    vols.set(spec.name, new VolState(spec, cfg.scenario, cfg.earnings));
    pool.ctx.set(spec.name, { spec, spot: 0, session: "UNKNOWN", fresh: false, sigma: { DAILY: spec.sigmaFloor, WEEKLY: spec.sigmaFloor }, hasVol: false, blockFromMs: null, blockToMs: null });
  }
  const jobs = buildJobs(cfg, paths, endSec);

  const postVols = (t: number): void => {
    for (const [name, vol] of vols) {
      const path = paths.get(name)!;
      const pt = path.at(t);
      if (!pt) continue;
      vol.observe(t, pt.p);
      const c = pool.ctx.get(name)!;
      c.sigma = { DAILY: vol.post(t, "DAILY"), WEEKLY: vol.post(t, "WEEKLY") };
      c.hasVol = true;
    }
  };
  // warm-up: the vol-engine needs history before the first post
  for (let t = Math.floor((cfg.startSec - 14 * DAY) / HOUR) * HOUR; t < cfg.startSec; t += HOUR) postVols(t);

  const twap = cfg.scenario.twap;
  const tradeGuard = cfg.scenario.tradeGuard;
  pool.holdS = tradeGuard?.holdS;
  const poolPaths = new Map([...paths].map(([name, p]) => [name, new PricePath(name, p.prints)]));
  const updateCtx = (t: number): void => {
    for (const [name, c] of pool.ctx) {
      const pt = paths.get(name)!.at(t);
      if (!pt) { c.spot = 0; continue; }
      c.spot = pt.p;
      c.session = sessionAt(t);
      c.fresh = t - pt.t <= FRESH_MAX_AGE;
      if (twap && isBuyableSession(c.session)) {
        const avg = modelTwap(poolPaths.get(name)!, t, twap.windowS, twap.leadS);
        const band = (twap.bandBps[name] ?? twap.defaultBandBps) / 10_000;
        c.twapPaused = avg === null || Math.abs(c.spot - avg) / avg > band;
      } else c.twapPaused = false;
      const tt = tradeGuard ? modelTwap(poolPaths.get(name)!, t, tradeGuard.windowS, twap?.leadS ?? 600) : null;
      if (tt !== null) c.tradeTwap = tt;
      else delete c.tradeTwap;
      const [from, to] = blockWindow(cfg.earnings, name, t);
      c.blockFromMs = from;
      c.blockToMs = to;
    }
  };

  // metrics
  const navHist: { t: number; ps: number }[] = [];
  const deque: { t: number; ps: number }[] = []; // monotonic max over the last 30 days
  let peakPs = 1, maxDd = 0, maxDd30 = 0, minNav = Infinity, minPs = Infinity;
  let insolventAt: number | null = null, liqInsolvent = false;
  let reservePeak = 0, reserveUsed = 0, peakEquityPs = 1;
  const perName: RunResult["perName"] = {};
  const sums: Record<string, { sum: number; n: number }> = {};
  for (const name of pool.ctx.keys()) {
    perName[name] = { maxOptionValuePctNav: 0, avgOptionValuePctNav: 0, maxUnhedgedDeltaPctNav: 0, maxNetDeltaUnits: 0, maxStressLossPctNav: 0 };
    sums[name] = { sum: 0, n: 0 };
  }
  let maxStress = 0;
  const daily: [string, number][] = [];
  let adversaryBuys = 0, jobsOpened = 0;
  const step = cfg.stepSeconds;
  const lpRng = new Rng(cfg.seed ^ 0x5bd1e995);

  for (let t = cfg.startSec; t < endSec; t += step) {
    pool.nowSec = t;
    updateCtx(t);
    if (t % HOUR === 0) postVols(t);
    pool.accrue(step);
    updateCtx(t);

    // sells that are due
    for (const p of [...pool.positions.values()]) if (p.sellAt <= t) pool.sell(p.id);

    // LP flows at the day boundary
    if (t % DAY === 0) {
      if (lpRng.chance(0.5)) pool.deposit(lpRng.uniform(50_000, 250_000));
      if (lpRng.chance(0.25)) pool.withdraw(lpRng.uniform(0.02, 0.08));
    }

    // retail
    for (const [name, c] of pool.ctx) {
      if (!(c.spot > 0) || !isBuyableSession(c.session)) continue;
      const n = rng.poisson((cfg.retailPerHour * cfg.scenario.retailScale * step) / HOUR);
      for (let i = 0; i < n; i++) {
        const speed: Speed = rng.chance(0.5) ? "DAILY" : "WEEKLY";
        const isCall = rng.chance(0.55);
        const offset = rng.pick([-0.1, -0.05, 0, 0.05, 0.1]);
        const strike = Math.max(c.spec.strikeStep, Math.round((c.spot * (1 + offset)) / c.spec.strikeStep) * c.spec.strikeStep);
        const hold = Math.max(1800, rng.exponential(speed === "DAILY" ? 1 * DAY : 4 * DAY));
        pool.buy(`retail-${rng.int(400)}`, "retail", name, isCall, strike, speed, rng.logUniform(100, 4000), t + hold);
      }
    }

    // adversary
    for (const job of jobs) {
      if (job.state !== "pending") continue;
      if (t >= job.entryBefore) { job.state = "done"; continue; }
      let moreChances = false;
      for (let u = t + step; u < job.entryBefore; u += step) if (isBuyableSession(sessionAt(u))) { moreChances = true; break; }
      if (moreChances || !isBuyableSession(sessionAt(t))) continue;
      const c = pool.ctx.get(job.name);
      if (!c || !(c.spot > 0)) { job.state = "done"; continue; }
      job.state = "done";
      let opened = 0;
      const offsets = job.isCall ? [0, 0.05] : [0, -0.05];
      for (const speed of ["DAILY", "WEEKLY"] as const) {
        for (const off of offsets) {
          const strike = Math.max(c.spec.strikeStep, Math.round((c.spot * (1 + off)) / c.spec.strikeStep) * c.spec.strikeStep);
          for (let a = 0; a < cfg.adversaryAccounts; a++) {
            const r = pool.buy(`adv-${a}`, job.group, job.name, job.isCall, strike, speed, LIMITS.perAccountSeriesUsd, job.jumpT + step);
            if (r.ok) { opened++; adversaryBuys++; }
          }
        }
      }
      if (opened > 0) { job.state = "open"; jobsOpened++; }
    }

    // hedge
    for (const name of pool.ctx.keys()) pool.rehedge(name);

    // drawdown auto-pause (30 day NAV per share), then metrics
    const equity = pool.equity();
    const ps = pool.navPerShare();
    minNav = Math.min(minNav, equity);
    minPs = Math.min(minPs, ps);
    if (equity < 0 && insolventAt === null) insolventAt = t;
    if (!liqInsolvent && pool.liquidationEquity() < 0) liqInsolvent = true;
    while (deque.length && deque[deque.length - 1]!.ps <= ps) deque.pop();
    deque.push({ t, ps });
    while (deque[0]!.t < t - 30 * DAY) deque.shift();
    const peak30 = deque[0]!.ps;
    const dd30 = peak30 > 0 ? (peak30 - ps) / peak30 : 0;
    maxDd30 = Math.max(maxDd30, dd30);
    pool.buysPausedByDrawdown = dd30 * 100 > LIMITS.drawdownPausePct;
    peakPs = Math.max(peakPs, ps);
    maxDd = Math.max(maxDd, (peakPs - ps) / peakPs);
    peakEquityPs = Math.max(peakEquityPs, ps);
    reservePeak = Math.max(reservePeak, pool.reserve);
    reserveUsed = Math.max(reserveUsed, Math.min(pool.reserve, Math.max(0, (peakEquityPs - ps) * pool.shares)));

    if (t % HOUR === 0 && equity > 0) {
      const stress = pool.stressLoss() / equity;
      maxStress = Math.max(maxStress, stress);
      for (const [name, c] of pool.ctx) {
        const m = perName[name]!;
        const optionPct = (pool.optionValueOfName(name) / equity) * 100;
        m.maxOptionValuePctNav = Math.max(m.maxOptionValuePctNav, optionPct);
        sums[name]!.sum += optionPct; sums[name]!.n++;
        const delta = pool.netDeltaUnits(name);
        const unhedged = Math.abs(delta - (pool.hedge.get(name) ?? 0)) * c.spot;
        m.maxUnhedgedDeltaPctNav = Math.max(m.maxUnhedgedDeltaPctNav, (unhedged / equity) * 100);
        m.maxNetDeltaUnits = Math.max(m.maxNetDeltaUnits, Math.abs(delta));
        m.maxStressLossPctNav = Math.max(m.maxStressLossPctNav, stress * 100);
      }
    }
    if (t % DAY === 0) daily.push([iso(t).slice(0, 10), Number(ps.toFixed(5))]);
    navHist.push({ t, ps });
  }

  pool.markOpenPositions();
  for (const name of Object.keys(perName)) perName[name]!.avgOptionValuePctNav = sums[name]!.n ? sums[name]!.sum / sums[name]!.n : 0;
  const insolvent = insolventAt !== null || pool.sellShortfall > 1;
  const failReasons: string[] = [];
  if (insolvent) failReasons.push(insolventAt !== null ? `insolvency: NAV below zero at ${iso(insolventAt)}` : `insolvency: sells short by $${pool.sellShortfall.toFixed(0)}`);
  if (maxDd30 * 100 > LIMITS.drawdownPausePct) failReasons.push(`30-day drawdown ${(maxDd30 * 100).toFixed(2)}% > ${LIMITS.drawdownPausePct}%`);
  const pausedOut = { ...pool.paused }; // BUYS_PAUSED = the 30-day drawdown auto-pause
  return {
    scenario: cfg.scenario.label, seed: cfg.seed, source: dataNotes.join("; "), startIso: iso(cfg.startSec), endIso: iso(endSec),
    insolvent, insolventAtIso: insolventAt === null ? null : iso(insolventAt),
    liquidationInsolvent: liqInsolvent, minNavUsd: minNav, minNavPerShare: minPs, finalNavUsd: pool.equity(), navPerShareFinal: pool.navPerShare(),
    maxDrawdownPct: maxDd * 100, maxDrawdown30dPct: maxDd30 * 100, pass: failReasons.length === 0, failReasons,
    pausedBuys: pausedOut, capBlocked: pool.capBlocked,
    trades: { buys: pool.buys, sells: pool.sells, hedgeTrades: pool.hedgeTrades, adversaryBuys, adversaryJobs: jobs.length, adversaryJobsOpened: jobsOpened },
    pnlByGroup: pool.pnl, reserve: { peakUsd: reservePeak, maxUsedUsd: reserveUsed, endUsd: pool.reserve },
    hedgeCostUsd: pool.hedgeCost, spreadIncomeUsd: pool.spreadIncome, feeIncomeUsd: pool.feeIncome, fundingIncomeUsd: pool.fundingIncome,
    sellShortfallUsd: pool.sellShortfall, perName, maxStressLossPctNav: maxStress * 100, dailyNavPerShare: daily, dataNotes,
  };
}
