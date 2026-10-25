import { decodeErrorResult, parseAbi, type Abi, type Hex } from "viem";
import { AgentRouterAbi, OptionEngineAbi, PoolAbi, PriceGuardAbi, SeriesRegistryAbi, VolOracleAbi } from "../abi";

/**
 * R14/R19: a revert from a node comes back as `execution reverted` plus a data field (geth, Nitro), and viem's message for it
 * is "Execution reverted for an unknown reason" unless the call was made with an ABI. The keeper simulates with raw calldata,
 * so no message ever carried the error's name, and every classifier that matched a name in the text (Slippage on a queued
 * sell, HedgerFrozen / HedgeLossBudget / PerpEquityCap on the hedger) silently never matched in production. This decodes the
 * revert data from wherever the error chain keeps it, against every contract's errors, and `RevertError` puts the name and
 * the arguments back in the message.
 */

/** PoolHedging errors are declared in the library, not in the pool's own ABI. */
const HedgingErrorsAbi = parseAbi([
  "error InvalidRoute()", "error StalePrice(address stock)", "error NoCash()", "error HedgeJump(uint256 previous, uint256 posted)",
  "error BadAsOf(uint64 asOf)", "error PerpEquityCap(uint256 posted, uint256 cap)", "error InvalidParams()", "error HedgerFrozen()",
  "error HedgeLossBudget(uint256 lossUsdg, uint256 budgetUsdg)",
]);

const DECODERS: readonly Abi[] = [OptionEngineAbi, PoolAbi, HedgingErrorsAbi, PriceGuardAbi, SeriesRegistryAbi, VolOracleAbi, AgentRouterAbi] as readonly Abi[];

const HEX = /^0x(?:[0-9a-fA-F]{2})+$/;

/** The revert data in an error chain: any `data` hex of at least a selector, on the error or a cause (or nested in a data object). */
export function revertDataOf(error: unknown): Hex | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 10 && current && typeof current === "object"; depth++) {
    const record = current as Record<string, unknown>;
    let data: unknown = record.data;
    for (let inner = 0; inner < 3 && data && typeof data === "object"; inner++) data = (data as Record<string, unknown>).data;
    if (typeof data === "string" && HEX.test(data) && data.length >= 10) return data as Hex;
    current = record.cause;
  }
  return undefined;
}

export interface DecodedRevert { readonly name: string; readonly args: readonly unknown[]; readonly signature: string }

/** The contract error named by the revert data of `error`, or undefined when there is none or no ABI here declares it. */
export function decodeRevert(error: unknown): DecodedRevert | undefined {
  const data = revertDataOf(error);
  if (!data) return undefined;
  for (const abi of DECODERS) {
    try {
      const decoded = decodeErrorResult({ abi, data });
      return { name: decoded.errorName, args: decoded.args ?? [], signature: data.slice(0, 10) };
    } catch { /* the next contract's errors */ }
  }
  return undefined;
}

const show = (value: unknown): string => (typeof value === "bigint" ? value.toString() : String(value));

/** A revert whose name is in the message. The original error is kept in `original`, not as `cause`: the logger prefers a
 * cause's message, which would hide the name again. */
export class RevertError extends Error {
  readonly errorName: string;
  readonly args: readonly unknown[];
  readonly original: unknown;
  constructor(decoded: DecodedRevert, original: unknown) {
    super(`execution reverted: ${decoded.name}(${decoded.args.map(show).join(", ")})`);
    this.name = "RevertError";
    this.errorName = decoded.name;
    this.args = decoded.args;
    this.original = original;
  }
}

/** `error` itself unless it carries decodable revert data, then a RevertError that names the contract error. */
export function withDecodedRevert(error: unknown): unknown {
  if (error instanceof RevertError) return error;
  const decoded = decodeRevert(error);
  return decoded ? new RevertError(decoded, error) : error;
}

/** The contract error name in `error` (decoded from data when present, else the legacy match on the message text). */
export function revertNameOf(error: unknown): string | undefined {
  if (error instanceof RevertError) return error.errorName;
  return decodeRevert(error)?.name;
}
