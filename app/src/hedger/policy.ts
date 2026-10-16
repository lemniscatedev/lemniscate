export type HoldReason = "session_closed" | "stale_inputs" | "below_min_size" | "cooldown" | "within_band" | "no_nav";
export type TradeReason = "band" | "interval";

export interface RehedgeInput {
  /** target - current position, stock units (signed). */
  gapUnits: number;
  spot: number;
  navUsdg: number;
  /** SessionKind name from the indexed tick. */
  session: string;
  inputsFresh: boolean;
  nowMs: number;
  lastTradeMs?: number | undefined;
  bandBps: number;
  intervalSeconds: number;
  cooldownSeconds: number;
  minTradeUsdg: number;
}

export type RehedgeDecision = { trade: true; reason: TradeReason } | { trade: false; reason: HoldReason };

/** Sessions in which hedge trading is allowed. CLOSED, UNKNOWN and HALTED never trade: weekend exposure is limited by
 * the caps, not by hedging. */
const TRADING_SESSIONS = new Set(["REGULAR", "EXTENDED"]);

/** R2. Trade when |gap| > bandBps of NAV, or the interval has passed while in session. Never when the session is not
 * tradable, below the minimum size, or inside the cool-down. Pure. */
export function decideRehedge(input: RehedgeInput): RehedgeDecision {
  if (!TRADING_SESSIONS.has(input.session)) return { trade: false, reason: "session_closed" };
  if (!input.inputsFresh) return { trade: false, reason: "stale_inputs" };
  if (!(input.navUsdg > 0)) return { trade: false, reason: "no_nav" };
  const notional = Math.abs(input.gapUnits) * input.spot;
  if (!(notional >= input.minTradeUsdg)) return { trade: false, reason: "below_min_size" };
  if (input.lastTradeMs !== undefined && input.nowMs - input.lastTradeMs < input.cooldownSeconds * 1000) {
    return { trade: false, reason: "cooldown" };
  }
  if (notional > (input.bandBps / 10_000) * input.navUsdg) return { trade: true, reason: "band" };
  if (input.lastTradeMs === undefined || input.nowMs - input.lastTradeMs >= input.intervalSeconds * 1000) {
    return { trade: true, reason: "interval" };
  }
  return { trade: false, reason: "within_band" };
}
