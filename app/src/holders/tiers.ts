/** $LMNS holder perks (Kal, 2026-10-29). Core features (trade, writer deposit, withdraw, /exit, every safety feature and
 * every public page) are never gated. Two levels unlock extras, read from the wallet's own $LMNS balance:
 *   holder  100,000+ LMNS   advanced analytics, alerts, a better fee tier, a writer reward boost
 *   whale 1,000,000+ LMNS   agent and automation tools, early access to new features, the top fee tier
 * The fee tiers themselves live on chain (LmnsStaking tiers, set by the timelock on token day); this module only says
 * which level a wallet reaches and what that level unlocks. Pure: no database, no RPC. */

export type HolderTier = "none" | "holder" | "whale";
export type PerkLevel = Exclude<HolderTier, "none">;

export interface TierThresholds {
  holderLmns: number;
  whaleLmns: number;
  decimals: number;
}

export interface Perk {
  id: string;
  name: string;
  level: PerkLevel;
}

/** What each level unlocks. Updates that add a gated feature add their perk here with the level it needs. */
export const PERKS: readonly Perk[] = [
  { id: "analytics", name: "Advanced analytics", level: "holder" },
  { id: "alerts", name: "Alerts", level: "holder" },
  { id: "fee-tier", name: "Better fee tier", level: "holder" },
  { id: "writer-boost", name: "Writer reward boost", level: "holder" },
  { id: "agents", name: "Agent and automation tools", level: "whale" },
  { id: "early-access", name: "Early access to new features", level: "whale" },
  { id: "fee-tier-top", name: "Top fee tier", level: "whale" },
];

const RANK: Record<HolderTier, number> = { none: 0, holder: 1, whale: 2 };

const units = (lmns: number, decimals: number): bigint => BigInt(Math.round(lmns)) * 10n ** BigInt(decimals);

/** The level a balance (in the token's smallest unit) reaches. Exactly the threshold counts. */
export function tierFor(balance: bigint, thresholds: TierThresholds): HolderTier {
  if (balance >= units(thresholds.whaleLmns, thresholds.decimals)) return "whale";
  if (balance >= units(thresholds.holderLmns, thresholds.decimals)) return "holder";
  return "none";
}

export function meetsTier(tier: HolderTier, required: PerkLevel): boolean {
  return RANK[tier] >= RANK[required];
}

export function minimumLmns(level: PerkLevel, thresholds: TierThresholds): number {
  return level === "whale" ? thresholds.whaleLmns : thresholds.holderLmns;
}

/** The plain line shown on a locked feature: "Hold 100,000 $LMNS to unlock". */
export function unlockText(level: PerkLevel, thresholds: TierThresholds): string {
  return `Hold ${minimumLmns(level, thresholds).toLocaleString("en-US")} $LMNS to unlock`;
}

export function perksFor(tier: HolderTier): { id: string; name: string; level: PerkLevel; unlocked: boolean }[] {
  return PERKS.map((perk) => ({ ...perk, unlocked: meetsTier(tier, perk.level) }));
}

/** Whole-token text of a balance, trimmed: 123456.5 LMNS -> "123456.5". */
export function lmnsText(balance: bigint, decimals: number): string {
  const scale = 10n ** BigInt(decimals);
  const whole = balance / scale;
  const fraction = (balance % scale).toString().padStart(decimals, "0").replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}
