// One place that turns (indexed flows, config, week) into the week's table, for the API and the payout export alike.
import type { Sql } from "postgres";
import {
  WEEK_SECONDS, excludedWallets, weekBounds, weeklyPoolUnits, writerRewards, type WriterRewardsConfig,
} from "../config/writer-rewards";
import { loadPoolFlows } from "./writer-history";
import { weekTable, type WeekTable } from "./writer-points";

export interface BuildWeekOptions {
  readonly sql: Sql;
  readonly pool: string;
  readonly contracts: Readonly<Record<string, string | undefined>>;
  /** Reward week number, or "preview" = the 7 days up to `nowSec` (before $LMNS launches). */
  readonly week: number | "preview";
  readonly nowSec: number;
  /** Contract wallets found by eth_getCode (payout export only); address -> reason. */
  readonly extraExcluded?: ReadonlyMap<string, string>;
  readonly config?: WriterRewardsConfig;
}

export async function buildWeek(options: BuildWeekOptions): Promise<WeekTable | null> {
  const config = options.config ?? writerRewards;
  let startSec: number;
  let endSec: number;
  if (options.week === "preview") {
    endSec = options.nowSec;
    startSec = endSec - WEEK_SECONDS;
  } else {
    const bounds = weekBounds(options.week, config);
    if (!bounds) return null;
    startSec = Math.floor(bounds.startMs / 1_000);
    endSec = Math.floor(bounds.endMs / 1_000);
  }
  const excluded = excludedWallets(options.contracts, config);
  for (const [address, reason] of options.extraExcluded ?? []) excluded.set(address, reason);
  const flows = await loadPoolFlows(options.sql, options.pool, endSec);
  return weekTable({
    flows, startSec, endSec, poolUnits: weeklyPoolUnits(config), perWalletCapBps: config.perWalletCapBps,
    minTimeWeightedUsdg: config.minTimeWeightedUsdg, redistributeOverCap: config.redistributeOverCap, excluded,
  });
}
