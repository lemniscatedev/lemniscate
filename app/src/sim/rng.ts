/** Seeded PRNG (mulberry32). Every random draw in the simulator goes through one of these, so a run is a pure
 * function of (config, seed, price data). */
export class Rng {
  private state: number;
  constructor(seed: number) {
    this.state = (seed >>> 0) || 0x9e3779b9;
  }
  /** Uniform in [0, 1). */
  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let t = this.state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  uniform(lo: number, hi: number): number { return lo + (hi - lo) * this.next(); }
  /** log-uniform in [lo, hi]. */
  logUniform(lo: number, hi: number): number { return Math.exp(this.uniform(Math.log(lo), Math.log(hi))); }
  int(n: number): number { return Math.floor(this.next() * n); }
  pick<T>(items: readonly T[]): T { return items[this.int(items.length)]!; }
  chance(p: number): boolean { return this.next() < p; }
  normal(): number {
    const u = Math.max(this.next(), 1e-12);
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * this.next());
  }
  exponential(mean: number): number { return -mean * Math.log(Math.max(1 - this.next(), 1e-12)); }
  /** Poisson draw (Knuth), fine for small means. */
  poisson(mean: number): number {
    const limit = Math.exp(-mean);
    let k = 0;
    let p = 1;
    do { k++; p *= this.next(); } while (p > limit);
    return k - 1;
  }
}
