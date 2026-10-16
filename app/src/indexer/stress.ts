import { formatUnits } from "viem";

const WAD = 10n ** 18n;
/** stress_loss_bps is stored with 4 decimals. */
const BPS_SCALE = 10_000n;
/** Reported when the pool would lose money against a NAV that is zero or negative. */
export const STRESS_LOSS_CAP_BPS = 1_000_000n;

export interface StressInput {
  /** The POOL's net delta in underlying units (WAD): minus engine.netGreeks, which is the holders' long side. */
  readonly deltaWad: bigint;
  /** The pool's net gamma: change of delta (underlying units, WAD) per 1 USDG move of the underlying. */
  readonly gammaWad: bigint;
  /** Underlying price, WAD USDG per whole Stock Token. */
  readonly spotWad: bigint;
  /** Pool NAV, WAD USDG. */
  readonly navWad: bigint;
  /** Size of the gap in basis points of spot (the risk spec uses 2500: a 25% gap). */
  readonly gapBps?: bigint;
}

/** Delta-gamma P&L of a net position for an underlying move of `moveWad`, WAD USDG. */
export function deltaGammaPnl(deltaWad: bigint, gammaWad: bigint, moveWad: bigint): bigint {
  return (deltaWad * moveWad) / WAD + (gammaWad * moveWad * moveWad) / (2n * WAD * WAD);
}

/**
 * Worst of the up gap and the down gap, as basis points of NAV (4 decimal places, as a decimal string).
 *
 * The greeks are taken as the pool's own exposure (what its P&L moves with). This is a monitoring figure for the
 * dashboards and the risk keeper's early warning; the engine's own StressBudget check on chain is authoritative.
 */
export function stressLossBps(input: StressInput): string {
  const gap = input.gapBps ?? 2_500n;
  const move = (input.spotWad * gap) / 10_000n;
  const up = deltaGammaPnl(input.deltaWad, input.gammaWad, move);
  const down = deltaGammaPnl(input.deltaWad, input.gammaWad, -move);
  const worstLoss = -(up < down ? up : down);
  if (worstLoss <= 0n) return formatUnits(0n, 4);
  if (input.navWad <= 0n) return formatUnits(STRESS_LOSS_CAP_BPS * BPS_SCALE, 4);
  const scaled = (worstLoss * 10_000n * BPS_SCALE) / input.navWad;
  const capped = scaled > STRESS_LOSS_CAP_BPS * BPS_SCALE ? STRESS_LOSS_CAP_BPS * BPS_SCALE : scaled;
  return formatUnits(capped, 4);
}
