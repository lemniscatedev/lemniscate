import type { Address } from "viem";

export const STOCK_DECIMALS = 18;
export const USDG_DECIMALS = 6;
export const WAD = 10n ** 18n;

/** Units: stock quantities are Stock Token wei (18 dp, signed), prices are USDG raw (6 dp) per whole Stock Token,
 * equity is USDG raw (6 dp). */
export interface HedgeFill {
  /** Venue reference: a transaction hash for spot, an order id for a perp venue. */
  ref: string;
  /** Signed stock wei actually traded (same sign as the request, may be smaller). */
  filled: bigint;
  /** Average USDG raw per whole stock (0 when nothing filled). */
  px: bigint;
}

export interface IHedgeVenue {
  name: string;
  /** True when the venue can hold a negative position (perps). Spot cannot. */
  canShort?: boolean;
  netPosition(stock: Address): Promise<bigint>;
  equityUsdg(): Promise<bigint>;
  trade(stock: Address, deltaUnits: bigint, maxSlippageBps: number): Promise<HedgeFill>;
  healthy(): Promise<boolean>;
  /** Largest absolute trade (stock wei) the venue takes right now in that direction; used to cap and to report unhedged delta. */
  maxTrade?(stock: Address, buy: boolean): Promise<bigint>;
}

export type Speed = "DAILY" | "WEEKLY";

export interface HedgerSettings {
  dryRun: boolean;
  bandBps: number;
  intervalSeconds: number;
  cooldownSeconds: number;
  minTradeUsdg: number;
  maxSlippageBps: number;
  twapSeconds: number;
  maxLiquidityBps: number;
  equityIntervalSeconds: number;
}

export const DEFAULT_SETTINGS: HedgerSettings = {
  dryRun: true,
  bandBps: 50,
  intervalSeconds: 1800,
  cooldownSeconds: 120,
  minTradeUsdg: 25,
  maxSlippageBps: 100,
  twapSeconds: 1800,
  maxLiquidityBps: 2500,
  equityIntervalSeconds: 3600,
};

export function toWei(units: number): bigint {
  if (!Number.isFinite(units)) throw new RangeError(`not a finite quantity: ${units}`);
  const negative = units < 0;
  const scaled = BigInt(Math.round(Math.abs(units) * 1e9)) * 10n ** 9n;
  return negative ? -scaled : scaled;
}

export const abs = (value: bigint): bigint => (value < 0n ? -value : value);
