import type { Address } from "viem";
import { abs, WAD, type HedgeFill, type IHedgeVenue } from "./types";

export interface MockPerpOptions {
  name?: string;
  /** USDG raw posted as margin. */
  collateral: bigint;
  /** Mark price per stock, USDG raw per whole stock. */
  prices: Map<string, bigint>;
  /** Fill price is the mark moved this many bps against the trader. */
  slippageBps?: number;
  /** Share of a requested trade that fills, in bps (10000 = all). */
  fillBps?: number;
  /** Funding paid by longs to shorts per hour, bps of notional (negative = shorts pay). */
  fundingBpsPerHour?: number;
  maxTradeUnits?: bigint;
}

/** R4. A deterministic perp venue for tests and dry runs: fixed fills, funding applied on demand, failure injection. */
export class MockPerpVenue implements IHedgeVenue {
  readonly name: string;
  readonly canShort = true;
  readonly positions = new Map<string, bigint>();
  readonly trades: { stock: string; filled: bigint; px: bigint }[] = [];
  private cash: bigint;
  private failures = 0;
  private failure = new Error("mock perp venue: injected failure");
  private up = true;
  constructor(private readonly options: MockPerpOptions) {
    this.name = options.name ?? "mock-perp";
    this.cash = options.collateral;
  }

  /** The next `times` calls to trade() throw. */
  failNext(times = 1, error?: Error): void {
    this.failures = times;
    if (error) this.failure = error;
  }
  setHealthy(healthy: boolean): void { this.up = healthy; }
  setPrice(stock: Address, px: bigint): void { this.options.prices.set(stock.toLowerCase(), px); }

  private mark(stock: string): bigint {
    const px = this.options.prices.get(stock.toLowerCase());
    if (px === undefined) throw new Error(`mock perp venue: no price for ${stock}`);
    return px;
  }

  async netPosition(stock: Address): Promise<bigint> {
    return this.positions.get(stock.toLowerCase()) ?? 0n;
  }

  async equityUsdg(): Promise<bigint> {
    let total = this.cash;
    for (const [stock, qty] of this.positions) total += (qty * this.mark(stock)) / WAD;
    return total;
  }

  async healthy(): Promise<boolean> { return this.up; }

  async maxTrade(): Promise<bigint> { return this.options.maxTradeUnits ?? 10n ** 30n; }

  async trade(stock: Address, deltaUnits: bigint, maxSlippageBps: number): Promise<HedgeFill> {
    if (this.failures > 0) { this.failures--; throw this.failure; }
    if (!this.up) throw new Error("mock perp venue: unhealthy");
    const slip = this.options.slippageBps ?? 0;
    if (slip > maxSlippageBps) throw new Error("mock perp venue: slippage above the limit");
    const filled = (deltaUnits * BigInt(this.options.fillBps ?? 10_000)) / 10_000n;
    if (filled === 0n) return { ref: "", filled: 0n, px: 0n };
    const mark = this.mark(stock);
    const px = filled > 0n ? (mark * BigInt(10_000 + slip)) / 10_000n : (mark * BigInt(10_000 - slip)) / 10_000n;
    const key = stock.toLowerCase();
    this.positions.set(key, (this.positions.get(key) ?? 0n) + filled);
    this.cash -= (filled * px) / WAD;
    this.trades.push({ stock: key, filled, px });
    return { ref: `mock-${this.trades.length}`, filled, px };
  }

  /** Applies funding for `hours`: positive rate means longs pay shorts. */
  accrueFunding(hours: number): void {
    const rate = BigInt(Math.round((this.options.fundingBpsPerHour ?? 0) * hours * 1e6));
    for (const [stock, qty] of this.positions) {
      const notional = (qty * this.mark(stock)) / WAD;
      this.cash -= (notional * rate) / (10_000n * 1_000_000n);
    }
  }

  totalAbsPosition(): bigint {
    let total = 0n;
    for (const qty of this.positions.values()) total += abs(qty);
    return total;
  }
}
