/** Launch caps and risk limits shown by /v1/config and /v1/pool. The contracts enforce them; these are the published
 * values (design decisions 6 and the master plan risk section). */
export const LAUNCH_CAPS = {
  poolNavUsdg: 2_000_000,
  perSeriesOutstandingUsdg: 40_000,
  perAccountSeriesUsdg: 25_000,
  /** Outstanding option value as a share of pool NAV. */
  totalOptionValuePctOfNav: 35,
  perNamePctOfNav: 8,
  /** Stress test: a 25% gap in one name with 10% moves elsewhere must stay inside this share of NAV. */
  stressBudgetPctOfNav: 20,
  /** A 30 day NAV-per-share drawdown beyond this pauses new buys. */
  drawdownPausePct: 15,
  writerVaultsOpen: false,
} as const;
