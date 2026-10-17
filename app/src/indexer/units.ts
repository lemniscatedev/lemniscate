import { formatUnits, type Address, type Hex } from "viem";

export const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000" as Address;

/** USDG has 6 decimals. */
export const USDG_DECIMALS = 6;
/** Option tokens are ERC-20 clones with 18 decimals. */
export const OPTION_TOKEN_DECIMALS = 18;
/** S, K, V, prices, units, norm, net greeks: WAD. */
export const WAD_DECIMALS = 18;

export const DAILY_TAU_SECONDS = 86_400;
export const WEEKLY_TAU_SECONDS = 604_800;

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

export function asHex32(value: unknown): Hex {
  return String(value).toLowerCase() as Hex;
}

/** Exact decimal string of an integer amount with `decimals` places. bigint math only, so no float loss. */
export function units(value: unknown, decimals: number): string {
  return formatUnits(asBigInt(value), decimals);
}

/** WAD (1e18) value -> decimal string. */
export function wad(value: unknown): string {
  return units(value, WAD_DECIMALS);
}

/** Signed WAD value (net greeks, NAV) -> decimal string. */
export function signedWad(value: bigint): string {
  return formatUnits(value, WAD_DECIMALS);
}

/** USDG raw (6 dp) -> decimal string. */
export function usdg(value: unknown): string {
  return units(value, USDG_DECIMALS);
}

/** Option-token raw amount (18 dp) -> decimal string. */
export function optionTokens(value: unknown): string {
  return units(value, OPTION_TOKEN_DECIMALS);
}

const SESSION_NAMES = ["REGULAR", "EXTENDED", "CLOSED", "UNKNOWN", "HALTED"] as const;
export type SessionName = (typeof SESSION_NAMES)[number];

export function sessionName(value: unknown): SessionName {
  const index = asNumber(value, -1);
  return SESSION_NAMES[index] ?? "UNKNOWN";
}

export function speedName(value: unknown): "DAILY" | "WEEKLY" {
  return asNumber(value) === 1 ? "WEEKLY" : "DAILY";
}

export function tauSeconds(speed: "DAILY" | "WEEKLY"): number {
  return speed === "WEEKLY" ? WEEKLY_TAU_SECONDS : DAILY_TAU_SECONDS;
}

/** bytes32 reason codes are short ASCII strings right padded with zeros ("EARNINGS", "SPLIT"). */
export function bytes32Text(value: unknown): string {
  const hex = String(value).toLowerCase();
  if (!/^0x[0-9a-f]{64}$/.test(hex)) return hex;
  const bytes = hex.slice(2).match(/../g)!.map((pair) => Number.parseInt(pair, 16));
  const end = bytes.findIndex((byte) => byte === 0);
  const used = end === -1 ? bytes : bytes.slice(0, end);
  if (used.length === 0) return "";
  const printable = used.every((byte) => byte >= 0x20 && byte < 0x7f);
  return printable ? String.fromCharCode(...used) : hex;
}

/** The last second Postgres timestamptz text and JS ISO strings both hold without a '+' year (9999-12-31T23:59:59Z). */
export const MAX_DB_UNIX_SECONDS = 253_402_300_799n;

/**
 * Chain unix seconds as a Date that can always be stored. Values a user controls (a uint64 expiresAt such as
 * type(uint64).max) are clamped to the year 9999 instead of throwing: an event must never halt ingestion (F04).
 */
export function unixToDate(value: unknown): Date {
  const seconds = asBigInt(value);
  const bounded = seconds < 0n ? 0n : seconds > MAX_DB_UNIX_SECONDS ? MAX_DB_UNIX_SECONDS : seconds;
  return new Date(Number(bounded) * 1_000);
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
