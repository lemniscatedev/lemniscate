import { decimal, fixed, multiply, ratioPercent, WAD } from "../../lib/fixed";
import { apiNow } from "../../api/clock";
import type { ApiDependencies, DbRow } from "../../api/types";
import { asRows, dateValue, textValue } from "../../api/types";
import { listMarkets } from "./markets";

const ZERO = "0x0000000000000000000000000000000000000000";
const BUCKETS = [
  { label: "<$10", min: 0n, max: 10n },
  { label: "$10–100", min: 10n, max: 100n },
  { label: "$100–1k", min: 100n, max: 1_000n },
  { label: "$1k–10k", min: 1_000n, max: 10_000n },
  { label: "≥$10k", min: 10_000n, max: null },
] as const; // dollars; multiply by WAD when comparing
export const HOLDER_ROW_LIMIT = 50_000;
const DAY_MS = 86_400_000;

export interface HolderRow extends DbRow {
  account: string;
  balance: string;
  first_at?: unknown;
}

export interface HolderBucket {
  label: string;
  minUsd: string;
  maxUsd: string | null;
  holders: number;
  supplySharePct: number;
}

export interface TopHolder {
  rank: number;
  address: string;
  balance: string;
  valueUsd: string;
  sharePct: number;
}

export interface HolderInsights {
  holders: number;
  totalSupply: string;
  top1SharePct: number | null;
  top10SharePct: number | null;
  newHolders7d: number;
  distribution: HolderBucket[];
  topHolders: TopHolder[];
}

export interface MarketHolders extends HolderInsights {
  symbol: string;
  priceUsd: string;
  asOf: string;
}

/** Rows must arrive sorted by balance, largest first. */
export function holderInsights(rows: HolderRow[], price: bigint, nowMs: number): HolderInsights {
  const balances = rows.map((row) => fixed(textValue(row.balance, "0")));
  const supply = balances.reduce((sum, balance) => sum + balance, 0n);
  const share = (value: bigint): number | null => supply > 0n ? ratioPercent(value, supply) : null;
  const top10 = balances.slice(0, 10).reduce((sum, balance) => sum + balance, 0n);
  const newSince = nowMs - 7 * DAY_MS;
  const newHolders7d = rows.filter((row) => {
    const firstAt = dateValue(row.first_at);
    return firstAt !== null && firstAt.getTime() >= newSince;
  }).length;

  const totals = BUCKETS.map(() => ({ holders: 0, balance: 0n }));
  for (const balance of balances) {
    const value = multiply(balance, price);
    const index = BUCKETS.findIndex((bucket) =>
      value >= bucket.min * WAD && (bucket.max === null || value < bucket.max * WAD));
    const total = totals[index];
    if (!total) continue;
    total.holders += 1;
    total.balance += balance;
  }

  return {
    holders: rows.length,
    totalSupply: decimal(supply),
    top1SharePct: share(balances[0] ?? 0n),
    top10SharePct: share(top10),
    newHolders7d,
    distribution: BUCKETS.map((bucket, index) => ({
      label: bucket.label,
      minUsd: String(bucket.min),
      maxUsd: bucket.max === null ? null : String(bucket.max),
      holders: totals[index]?.holders ?? 0,
      supplySharePct: share(totals[index]?.balance ?? 0n) ?? 0,
    })),
    topHolders: rows.slice(0, 10).map((row, index) => {
      const balance = balances[index] ?? 0n;
      return {
        rank: index + 1,
        address: row.account,
        balance: decimal(balance),
        valueUsd: decimal(multiply(balance, price)),
        sharePct: share(balance) ?? 0,
      };
    }),
  };
}

export async function marketHolders(deps: ApiDependencies, symbol: string, requestedNow?: Date): Promise<MarketHolders | null> {
  const now = requestedNow ?? await apiNow(deps);
  const markets = await deps.cache.getOrLoad("markets:list", 3_000, () => listMarkets(deps));
  const market = markets.find((candidate) => candidate.symbol.toUpperCase() === symbol.toUpperCase());
  if (!market) return null;

  const excluded = [ZERO, deps.deployment.contracts.engine, deps.deployment.contracts.vault].map((address) => address.toLowerCase());
  const result = await deps.sql`
    select b.account, b.balance::text as balance,
      least(
        (select min(t.ts) from trades t where t.market_id = ${market.id} and t.recipient = b.account),
        (select min(x.ts) from transfers x where x.token = ${market.token} and x.to_addr = b.account)
      ) as first_at
    from balances b
    where b.token = ${market.token} and b.balance > 0 and b.account <> all(${excluded}::text[])
    order by b.balance desc, b.account asc
    limit ${HOLDER_ROW_LIMIT}
  `;
  return {
    symbol: market.symbol,
    priceUsd: market.price,
    asOf: now.toISOString(),
    ...holderInsights(asRows<HolderRow>(result), fixed(market.price), now.getTime()),
  };
}
