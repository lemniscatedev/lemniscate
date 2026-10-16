import { encodeAbiParameters, keccak256, parseUnits, type Address, type Hex } from "viem";

/** Leaf encoding of the hourly receipts. Every leaf is keccak256(abi.encode(kind, ...fields)); amounts are the raw
 * on-chain integers (USDG 6 dp, WAD 18 dp, option tokens 18 dp), times are unix seconds.
 *
 *  kind 1  trade     (uint8 kind, bytes32 txHash, uint32 logIndex, uint64 ts, bytes32 seriesId, address account,
 *                     address recipient, uint8 side [0 buy, 1 sell], uint256 units, uint256 tokens, uint256 usdg,
 *                     uint256 vMarkWad, uint64 sigmaBps, uint8 session [SessionKind])
 *  kind 2  vol post  (uint8 kind, bytes32 txHash, uint32 logIndex, uint64 ts, address stock, uint8 speed [0 daily,
 *                     1 weekly], uint64 sigmaBps, uint256 skewK, uint64 eventBumpBps, uint64 buyBlockFrom,
 *                     uint64 buyBlockTo [0 = none], uint64 validUntil, uint256 nonce)
 *  kind 3  NAV       (uint8 kind, uint64 ts, uint64 block, uint256 usdg, uint256 hedgeEquity, uint256 optionLiabilityWad,
 *                     uint256 reserve, int256 navWad, uint256 navPerShareWad)
 * The period is [start, end) in UTC, an hour. A row belongs to the hour of its `ts`. */
export const LEAF_KIND = { trade: 1, volPost: 2, nav: 3 } as const;

const SESSIONS = ["REGULAR", "EXTENDED", "CLOSED", "UNKNOWN", "HALTED"];

const secs = (value: Date | string): bigint => BigInt(Math.floor(new Date(value).getTime() / 1000));
const raw = (value: string | number | null | undefined, decimals: number): bigint => parseUnits(String(value ?? 0), decimals);
/** Decimal strings from numeric(78,18) columns carry 18 fraction digits; 6 dp amounts only ever have zeros beyond 6. */
const usdg = (value: string | number | null | undefined): bigint => {
  const text = String(value ?? 0);
  const [whole, fraction = ""] = text.split(".");
  return parseUnits(`${whole}.${fraction.slice(0, 6).padEnd(6, "0")}`, 6);
};

export interface TradeRow {
  tx_hash: string; log_index: number; ts: Date | string; series_id: string; account: string; recipient: string;
  side: string; units: string; shares: string; usdg: string; v_mark: string; sigma_bps: number; session: string;
}
export interface VolPostRow {
  tx_hash: string; log_index: number; ts: Date | string; stock_token: string; speed: string; sigma_bps: number;
  skew_k: string; event_bump_bps: number; buy_block_from: Date | string | null; buy_block_to: Date | string | null;
  valid_until: Date | string; nonce: string;
}
export interface NavRow {
  ts: Date | string; block: string | number | bigint; usdg: string; hedge_equity: string; option_liability: string;
  reserve: string; nav: string; nav_per_share: string;
}

export function tradeLeaf(row: TradeRow): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "uint8" }, { type: "bytes32" }, { type: "uint32" }, { type: "uint64" }, { type: "bytes32" }, { type: "address" },
      { type: "address" }, { type: "uint8" }, { type: "uint256" }, { type: "uint256" }, { type: "uint256" },
      { type: "uint256" }, { type: "uint64" }, { type: "uint8" },
    ],
    [
      LEAF_KIND.trade, row.tx_hash as Hex, row.log_index, secs(row.ts), row.series_id as Hex, row.account as Address,
      row.recipient as Address, row.side === "sell" ? 1 : 0, raw(row.units, 18), raw(row.shares, 18), usdg(row.usdg),
      raw(row.v_mark, 18), BigInt(row.sigma_bps), Math.max(0, SESSIONS.indexOf(row.session) < 0 ? 3 : SESSIONS.indexOf(row.session)),
    ],
  ));
}

export function volPostLeaf(row: VolPostRow): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "uint8" }, { type: "bytes32" }, { type: "uint32" }, { type: "uint64" }, { type: "address" }, { type: "uint8" },
      { type: "uint64" }, { type: "uint256" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" }, { type: "uint64" },
      { type: "uint256" },
    ],
    [
      LEAF_KIND.volPost, row.tx_hash as Hex, row.log_index, secs(row.ts), row.stock_token as Address,
      row.speed === "WEEKLY" ? 1 : 0, BigInt(row.sigma_bps), BigInt(row.skew_k), BigInt(row.event_bump_bps),
      row.buy_block_from ? secs(row.buy_block_from) : 0n, row.buy_block_to ? secs(row.buy_block_to) : 0n,
      secs(row.valid_until), BigInt(row.nonce),
    ],
  ));
}

export function navLeaf(row: NavRow): Hex {
  return keccak256(encodeAbiParameters(
    [
      { type: "uint8" }, { type: "uint64" }, { type: "uint64" }, { type: "uint256" }, { type: "uint256" },
      { type: "uint256" }, { type: "uint256" }, { type: "int256" }, { type: "uint256" },
    ],
    [
      LEAF_KIND.nav, secs(row.ts), BigInt(row.block), usdg(row.usdg), usdg(row.hedge_equity), raw(row.option_liability, 18),
      usdg(row.reserve), raw(row.nav, 18), raw(row.nav_per_share, 18),
    ],
  ));
}
