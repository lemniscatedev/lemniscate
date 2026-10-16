import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { CACHE_DIR, type CachedRounds } from "./cache";
import { Rng } from "./rng";
import { sessionAt } from "./sessions";
import type { NameSpec } from "./types";

export interface Print { t: number; p: number }

/** A feed as the pool sees it: a step function of price prints. */
export class PricePath {
  private idx = 0;
  constructor(readonly name: string, readonly prints: readonly Print[]) {
    for (let i = 1; i < prints.length; i++) if (prints[i]!.t < prints[i - 1]!.t) throw new Error(`${name}: prints out of order`);
  }
  get firstT(): number { return this.prints[0]?.t ?? Infinity; }
  get lastT(): number { return this.prints[this.prints.length - 1]?.t ?? -Infinity; }
  reset(): void { this.idx = 0; }
  /** Last print at or before tSec (sequential access is O(1) amortised; random access falls back to a search). */
  at(tSec: number): Print | null {
    const p = this.prints;
    if (p.length === 0 || tSec < p[0]!.t) return null;
    if (this.idx >= p.length || p[this.idx]!.t > tSec) this.idx = 0;
    while (this.idx + 1 < p.length && p[this.idx + 1]!.t <= tSec) this.idx++;
    return p[this.idx]!;
  }
  /** Prints inside (fromSec, toSec]. */
  between(fromSec: number, toSec: number): Print[] {
    return this.prints.filter((x) => x.t > fromSec && x.t <= toSec);
  }
}

/** Multiply the log return of every print whose move is at least `threshold` (sensitivity: gaps x mult). */
export function scaleGaps(path: PricePath, mult: number, threshold = 0.01): PricePath {
  if (mult === 1) return path;
  const out: Print[] = [];
  let level = path.prints[0]?.p ?? 0;
  for (let i = 0; i < path.prints.length; i++) {
    const cur = path.prints[i]!;
    if (i === 0) { out.push({ ...cur }); continue; }
    const r = Math.log(cur.p / path.prints[i - 1]!.p);
    level *= Math.exp(Math.abs(r) >= threshold ? r * mult : r);
    out.push({ t: cur.t, p: level });
  }
  return new PricePath(path.name, out);
}

export interface LoadedPrices {
  paths: Map<string, PricePath>;
  notes: string[];
}

/** Historical Chainlink rounds from the local cache. Drops obviously invalid rounds (the first rounds of a young feed
 * carry 18-decimal test values) and reports what it dropped. */
export async function loadCached(names: readonly string[], dir = CACHE_DIR): Promise<LoadedPrices> {
  const paths = new Map<string, PricePath>();
  const notes: string[] = [];
  for (const name of names) {
    let cached: CachedRounds;
    try {
      cached = JSON.parse(await readFile(join(dir, `${name}.json`), "utf8")) as CachedRounds;
    } catch {
      notes.push(`${name}: no cached rounds (run scripts/replay/fetch.ts)`);
      continue;
    }
    const scale = 10 ** cached.decimals;
    const raw = cached.rounds.map(([, t, a]) => ({ t, p: Number(a) / scale })).filter((x) => Number.isFinite(x.p) && x.p > 0).sort((a, b) => a.t - b.t);
    const sorted = raw.map((x) => x.p).sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
    const kept = raw.filter((x) => x.p > median * 0.3 && x.p < median * 3);
    const dropped = raw.length - kept.length;
    if (dropped > 0) notes.push(`${name}: dropped ${dropped} of ${raw.length} rounds outside 0.3x to 3x of the median price (young-feed test values)`);
    if (kept.length === 0) { notes.push(`${name}: no usable rounds`); continue; }
    paths.set(name, new PricePath(name, kept));
    notes.push(`${name}: ${kept.length} rounds, ${new Date(kept[0]!.t * 1000).toISOString().slice(0, 10)} to ${new Date(kept[kept.length - 1]!.t * 1000).toISOString().slice(0, 10)}`);
  }
  return { paths, notes };
}

/** Deterministic synthetic 24/5 feed, for the --fixture runs and the tests: lognormal diffusion with a weekend gap and
 * random jumps, printed with the real feed's rule (0.5% deviation or a 24 h heartbeat). Not market data. */
export function fixturePrices(specs: readonly NameSpec[], startSec: number, endSec: number, seed: number): LoadedPrices {
  const paths = new Map<string, PricePath>();
  specs.forEach((spec, k) => {
    const rng = new Rng(seed * 7919 + k * 104729 + 17);
    const dt = 900;
    const sigmaStep = spec.fixtureVol * Math.sqrt(dt / (365 * 86400)) * 1.6; // trading-hours-only diffusion
    let price = spec.fixtureSpot;
    let printed = price;
    let lastPrintT = startSec;
    const prints: Print[] = [{ t: startSec, p: price }];
    for (let t = startSec + dt; t <= endSec; t += dt) {
      const session = sessionAt(t);
      if (session === "CLOSED") continue;
      const weekendOpen = new Date(t * 1000).getUTCDay() === 1 && new Date(t * 1000).getUTCHours() === 0 && new Date(t * 1000).getUTCMinutes() === 0;
      let r = rng.normal() * sigmaStep * (session === "REGULAR" ? 1 : 0.5);
      if (weekendOpen) r += rng.normal() * spec.weekendMove * 0.7;
      if (rng.chance(1 / (4 * 96 * 5))) r += rng.normal() * spec.earningsMove * 0.6; // an occasional jump
      price *= Math.exp(r);
      if (Math.abs(price / printed - 1) >= 0.005 || t - lastPrintT >= 86400) {
        prints.push({ t, p: price });
        printed = price;
        lastPrintT = t;
      }
    }
    paths.set(spec.name, new PricePath(spec.name, prints));
  });
  return { paths, notes: ["fixture: deterministic synthetic prices (not market data)"] };
}

/** Adds a hard step to a feed: from tSec on, every price is multiplied by exp(logMove), and a print at tSec shows it at once. */
export function injectGap(path: PricePath, tSec: number, logMove: number): PricePath {
  const before = path.prints.filter((x) => x.t < tSec);
  const after = path.prints.filter((x) => x.t >= tSec);
  const last = before[before.length - 1];
  if (!last) return path;
  const factor = Math.exp(logMove);
  const out: Print[] = [...before, { t: tSec, p: last.p * factor }];
  for (const x of after) if (x.t > tSec) out.push({ t: x.t, p: x.p * factor });
  return new PricePath(path.name, out);
}
