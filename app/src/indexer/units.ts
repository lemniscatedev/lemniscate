import { formatUnits, parseUnits, type Address, type Hex } from "viem";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;
export const USDG_DECIMALS = 6;
export const POWER_TOKEN_DECIMALS = 18;
export const LWP_DECIMALS = 12;
export const WAD_DECIMALS = 18;

export function asBigInt(value: unknown, fallback = 0n): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number" && Number.isSafeInteger(value)) return BigInt(value);
  if (typeof value === "string" && /^(?:0x[0-9a-f]+|\d+)$/i.test(value)) {
    return BigInt(value);
  }
  return fallback;
}

export function asNumber(value: unknown, fallback = 0): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "bigint") return Number(value);
  if (typeof value === "string" && value.trim() !== "") {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

export function asAddress(value: unknown): Address {
  return String(value).toLowerCase() as Address;
}

export function units(value: unknown, decimals: number): string {
  return formatUnits(asBigInt(value), decimals);
}

export function wad(value: unknown): string {
  return units(value, WAD_DECIMALS);
}

export function usdg(value: unknown): string {
  return units(value, USDG_DECIMALS);
}

export function power(value: unknown): string {
  return units(value, POWER_TOKEN_DECIMALS);
}

export function writerPool(value: unknown): string {
  return units(value, LWP_DECIMALS);
}

export function parseUsdg(value: string): bigint {
  return parseUnits(value, USDG_DECIMALS);
}

export function parseChainTimestamp(value: unknown): Date | undefined {
  const timestamp = asBigInt(value, -1n);
  // Some RHC log providers include 0x0 as a missing blockTimestamp marker.
  // It is not a real event time: resolve the canonical block header instead.
  if (timestamp <= 0n || timestamp > BigInt(Math.floor(8.64e12))) return undefined;
  return new Date(Number(timestamp) * 1_000);
}

export function blockHex(block: bigint): Hex {
  return `0x${block.toString(16)}` as Hex;
}
