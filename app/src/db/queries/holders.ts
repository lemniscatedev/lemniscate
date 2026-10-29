import type { ApiDependencies } from "../../api/types";
import { lmnsText, tierFor, type HolderTier, type TierThresholds } from "../../holders/tiers";

export type HolderStatus = "awaiting_token" | "checking" | "ok";

export interface HolderLevel {
  status: HolderStatus;
  tier: HolderTier;
  balanceLmns: string | null;
  updatedAt: string | null;
}

export function thresholdsOf(deps: Pick<ApiDependencies, "config">): TierThresholds {
  const c = deps.config;
  return { holderLmns: c.HOLDER_TIER_HOLDER_LMNS, whaleLmns: c.HOLDER_TIER_WHALE_LMNS, decimals: c.LMNS_DECIMALS };
}

/** The wallet's holder level from the keeper's last balance read. Also (re)registers the wallet with the keeper. A missing,
 * wrong-token or stale reading is "checking" with tier "none": perks stay locked until a fresh balance is in (fail closed).
 * Core features never call this. */
export async function holderLevel(deps: ApiDependencies, address: string, nowMs = Date.now()): Promise<HolderLevel> {
  const wallet = address.toLowerCase();
  const token = deps.config.LMNS_TOKEN_ADDRESS.toLowerCase();
  if (!token) return { status: "awaiting_token", tier: "none", balanceLmns: null, updatedAt: null };
  await deps.sql`
    insert into holder_watch (address, requested_at) values (${wallet}, now())
    on conflict (address) do update set requested_at = excluded.requested_at
    where holder_watch.requested_at < now() - interval '1 minute'`;
  const rows = await deps.sql<{ token: string; balance: string; updated_at: Date | string }[]>`
    select token, balance::text as balance, updated_at from holder_balances where address = ${wallet}`;
  const row = rows[0];
  if (!row || row.token !== token) return { status: "checking", tier: "none", balanceLmns: null, updatedAt: null };
  const updated = row.updated_at instanceof Date ? row.updated_at : new Date(row.updated_at);
  const balance = BigInt(row.balance);
  const balanceLmns = lmnsText(balance, deps.config.LMNS_DECIMALS);
  if (nowMs - updated.getTime() > deps.config.HOLDER_BALANCE_TTL_SECONDS * 3000) {
    return { status: "checking", tier: "none", balanceLmns, updatedAt: updated.toISOString() };
  }
  return { status: "ok", tier: tierFor(balance, thresholdsOf(deps)), balanceLmns, updatedAt: updated.toISOString() };
}
