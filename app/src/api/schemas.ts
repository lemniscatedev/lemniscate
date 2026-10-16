import { z } from "@hono/zod-openapi";
import { isAddress } from "viem";

const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
export const isoDateTime = z.string().datetime({ offset: true });
const percent = z.number().finite();
const earningsSession = z.enum(["pre", "post", "unknown"]);

export const errorResponseSchema = z.object({ error: z.string(), message: z.string() });

export const healthResponseSchema = z.object({
  ok: z.boolean(),
  db: z.object({ ok: z.boolean() }),
  lastIndexedBlock: z.number().int().nonnegative().nullable(),
  headBlock: z.number().int().nonnegative().nullable(),
  lagBlocks: z.number().int().nonnegative().nullable(),
  keeper: z.record(z.string(), z.object({
    status: z.enum(["ok", "error", "pending"]), lastOk: isoDateTime.nullable(), lastRun: isoDateTime.nullable(),
  })),
  rpc: z.object({ date: z.string().nullable(), keys: z.array(z.object({
    id: z.string(), requestsToday: z.number().int().nonnegative(), estimatedCuToday: z.number().int().nonnegative(), cooling: z.boolean(),
  })) }),
  warnings: z.array(z.string()),
});

export const configResponseSchema = z.object({
  chainId: z.number().int(),
  network: z.enum(["mainnet", "fork"]),
  forkProof: z.object({ blockNumber: z.number().int().nonnegative(), blockHash: z.string() }).optional(),
  rpcUrl: z.string().url(),
  explorerUrl: z.string().url(),
  contracts: z.object({ engine: z.string(), vault: z.string(), lens: z.string(), usdg: z.string(), marketHours: z.string() }),
  markets: z.array(z.object({ id: z.number().int(), symbol: z.string(), token: z.string(), stock: z.string(), decimals: z.literal(18) })),
  usdgDecimals: z.literal(6),
  writerPoolDecimals: z.literal(12),
  features: z.object({ publicDeposits: z.boolean(), shorts: z.boolean(), limitOrders: z.boolean(), ratio: z.boolean() }),
});

export const sparklineSchema = z.array(z.object({ t: z.number().int(), p: decimal }));

export const marketSchema = z.object({
  id: z.number().int(), symbol: z.string(), token: z.string(), regime: z.enum(["open", "off_hours", "paused"]),
  curve: z.enum(["squared", "ratio", "cubed", "root", "downside", "unknown"]), exponent: z.number().nullable(),
  alwaysOpen: z.boolean(), underlying: z.string(), launched: z.boolean(),
  nextEarnings: z.object({
    date: z.string(), session: earningsSession, confirmed: z.boolean(), daysUntil: z.number().int(),
  }).nullable(),
  meta: z.object({ name: z.string(), category: z.string(), color: z.string().regex(/^#[0-9a-fA-F]{6}$/) }).optional(),
  session: z.object({ open: z.boolean(), opensAt: isoDateTime.nullable(), closesAt: isoDateTime.nullable() }),
  buysPaused: z.boolean(), spot: decimal, index: decimal, price: decimal, bid: decimal, ask: decimal,
  dailyCarryPct: percent, change24hPct: percent, volume24hUsd: decimal, openInterestUsd: decimal,
  capacityUsd: decimal, utilizationPct: percent, oracleUpdatedAt: isoDateTime.nullable(), asOf: isoDateTime.nullable(),
  sparkline: sparklineSchema,
  reference: z.object({
    bid: decimal, ask: decimal, mid: decimal,
    dayHigh: decimal.nullable(), dayLow: decimal.nullable(),
    lagBps: z.number().finite().nullable(), halt: z.boolean(), quotedAt: isoDateTime, stale: z.boolean(),
  }).nullable().optional(),
  corpAction: z.object({ kind: z.string(), effectiveAt: isoDateTime.nullable(), status: z.string() }).optional(),
  quoteParams: z.object({ feeBps: z.number().int(), spreadBps: z.number().int(), bandBps: z.number().int(), impactBps: z.number().int(),
    maxTradeUsd: decimal, minTradeUsd: decimal, capacityUsd: decimal, globalCapacityUsd: decimal }),
});

export const marketListResponseSchema = z.array(marketSchema);
export const marketDetailResponseSchema = marketSchema.extend({
  config: z.record(z.string(), z.unknown()),
  stats: z.object({
    trades24h: z.number().int().nonnegative(), holders: z.number().int().nonnegative(),
    buyVolume24hUsd: decimal, sellVolume24hUsd: decimal,
  }),
});

export const candleSchema = z.array(z.object({
  t: z.number().int(), o: decimal, h: decimal, l: decimal, c: decimal,
  v: decimal, vb: decimal, vs: decimal, n: z.number().int().nonnegative(),
}));
export const carrySchema = z.array(z.object({ t: z.number().int(), dailyCarryPct: percent, regime: z.enum(["open", "off_hours", "paused"]) }));

export const tradeListSchema = z.array(z.object({
  txHash: z.string(), side: z.enum(["buy", "sell"]), account: z.string(), recipient: z.string(),
  usdg: decimal, fee: decimal, tokens: decimal, price: decimal, ts: isoDateTime,
}));
export const regimeListSchema = z.array(z.object({
  txHash: z.string(), from: z.enum(["open", "off_hours", "paused"]), to: z.enum(["open", "off_hours", "paused"]), ts: isoDateTime,
}));

export const marketHoldersResponseSchema = z.object({
  symbol: z.string(), priceUsd: decimal, asOf: isoDateTime,
  holders: z.number().int().nonnegative(), totalSupply: decimal,
  top1SharePct: percent.nullable(), top10SharePct: percent.nullable(), newHolders7d: z.number().int().nonnegative(),
  distribution: z.array(z.object({ label: z.string(), minUsd: decimal, maxUsd: decimal.nullable(), holders: z.number().int().nonnegative(), supplySharePct: percent })),
  topHolders: z.array(z.object({ rank: z.number().int().positive(), address: z.string(), balance: decimal, valueUsd: decimal, sharePct: percent })),
});

export const portfolioResponseSchema = z.object({
  positions: z.array(z.object({ symbol: z.string(), balance: decimal, price: decimal, value: decimal, avgCost: decimal,
    costBasis: decimal, unrealizedPnl: decimal, realizedPnl: decimal })),
  writerPool: z.object({ shares: decimal, value: decimal, costBasis: decimal, change: decimal, changePct: percent.nullable(),
    historyComplete: z.boolean(), unlockTime: isoDateTime.nullable(), isDepositor: z.boolean() }),
  totals: z.object({ powerValue: decimal, unrealizedPnl: decimal, realizedPnl: decimal }),
  /** False when the cost-basis ledger was capped to the newest entries. */
  historyComplete: z.boolean(),
});

export const activityResponseSchema = z.object({
  items: z.array(z.object({ id: z.string(), kind: z.enum(["buy", "sell", "deposit", "withdraw", "transfer_in", "transfer_out"]),
    symbol: z.string(), usdg: decimal.nullable(), tokens: decimal.nullable(), price: decimal.nullable(), ts: isoDateTime, txHash: z.string() })),
  nextCursor: z.string().nullable(),
});

export const vaultResponseSchema = z.object({
  nav: decimal, navPerShare: decimal, totalSupply: decimal, usdg: decimal, totalLiability: decimal,
  utilizationPct: percent, maxGlobalExposurePct: percent, publicDeposits: z.boolean(),
  markets: z.array(z.object({ symbol: z.string(), liability: decimal, hedgeUnits: decimal, hedgeTarget: decimal, hedgeValue: decimal, deltaPct: percent })),
  change7dPct: percent, change30dPct: percent.nullable(), changeSinceInceptionPct: percent.nullable(),
  carryEarned30d: decimal.optional(), depositCapRemaining: decimal,
});
export const vaultHistorySchema = z.array(z.object({ t: z.number().int(), navPerShare: decimal, nav: decimal }));
export const corpActionsSchema = z.array(z.object({ id: z.string(), symbol: z.string(), kind: z.string(), status: z.string(),
  processDate: z.string().nullable(), effectiveAt: isoDateTime.nullable(), oldMultiplier: decimal.nullable(), newMultiplier: decimal.nullable(),
  verifiedContinuity: z.boolean().nullable(), details: z.record(z.string(), z.unknown()) }));
export const statsResponseSchema = z.object({ openInterestUsd: decimal, volume24hUsd: decimal, trades24h: z.number().int().nonnegative(), tvlUsd: decimal,
  fees24hUsd: decimal, uniqueTraders24h: z.number().int().nonnegative(), volumeAllTimeUsd: decimal,
  tradesAllTime: z.number().int().nonnegative(), tradersAllTime: z.number().int().nonnegative(),
  markets: z.array(z.object({ symbol: z.string(), price: decimal, dailyCarryPct: percent, regime: z.enum(["open", "off_hours", "paused"]) })) });

const count = z.number().int().nonnegative();
export const historyRangeQuery = z.object({ range: z.enum(["7D", "30D", "90D", "ALL"]).default("30D") });
export const statsHistoryResponseSchema = z.object({
  range: z.enum(["7D", "30D", "90D", "ALL"]), from: isoDateTime, to: isoDateTime,
  summary: z.object({ volumeUsd: decimal, buyVolumeUsd: decimal, sellVolumeUsd: decimal, feesUsd: decimal, trades: count, uniqueTraders: count }),
  points: z.array(z.object({ t: z.number().int(), volumeUsd: decimal, buyVolumeUsd: decimal, sellVolumeUsd: decimal, feesUsd: decimal,
    trades: count, uniqueTraders: count, tvlUsd: decimal.nullable() })),
  markets: z.array(z.object({ symbol: z.string(), volumeUsd: decimal, trades: count, sharePct: percent })),
});

export const correlationQuery = z.object({ days: z.enum(["7", "30"]).default("30") });
export const correlationResponseSchema = z.object({
  days: z.union([z.literal(7), z.literal(30)]),
  asOf: isoDateTime,
  minOverlap: z.number().int().positive(),
  symbols: z.array(z.string()),
  values: z.array(z.array(z.number().min(-1).max(1).nullable())),
  overlap: z.array(z.array(z.number().int().nonnegative())),
});

const boardRange = z.enum(["7D", "30D", "ALL"]);
const boardSort = z.enum(["volume", "trades"]);
export const leaderboardQuery = z.object({
  range: boardRange.default("7D"),
  sort: boardSort.default("volume"),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  address: z.string().refine((value) => isAddress(value, { strict: false }), "Invalid EVM address").transform((value) => value.toLowerCase()).optional(),
});
const leaderboardRowSchema = z.object({ rank: z.number().int().positive(), address: z.string(), volumeUsd: decimal,
  trades: count, markets: count, topMarket: z.string().nullable(), lastTradeAt: isoDateTime });
export const leaderboardResponseSchema = z.object({ range: boardRange, sort: boardSort,
  totalTraders: count, rows: z.array(leaderboardRowSchema), you: leaderboardRowSchema.nullable(), generatedAt: isoDateTime });

const closeSummarySchema = z.object({ symbol: z.string(), realizedPnlUsd: decimal, ts: isoDateTime, txHash: z.string() });
export const accountStatsResponseSchema = z.object({
  volumeUsd: decimal, feesPaidUsd: decimal, trades: count, buys: count, sells: count, marketsTraded: count, activeDays: count,
  firstTradeAt: isoDateTime.nullable(), lastTradeAt: isoDateTime.nullable(),
  realizedPnlUsd: decimal, closedTrades: count, winningTrades: count, winRatePct: percent.nullable(),
  bestTrade: closeSummarySchema.nullable(), worstTrade: closeSummarySchema.nullable(),
  markets: z.array(z.object({ symbol: z.string(), volumeUsd: decimal, trades: count, realizedPnlUsd: decimal })),
  /** False when the replayed ledger was capped to the newest entries. */
  historyComplete: z.boolean(),
});

export const symbolParams = z.object({ symbol: z.string().min(1).max(16).transform((value) => value.toUpperCase()) });
export const addressParams = z.object({ address: z.string().refine((value) => isAddress(value, { strict: false }), "Invalid EVM address").transform((value) => value.toLowerCase()) });
export const upcomingQuery = z.object({
  address: z.string().refine((value) => isAddress(value, { strict: false }), "Invalid EVM address")
    .transform((value) => value.toLowerCase()).optional(),
});
export const signedBodySchema = z.object({
  address: z.string().refine((value) => isAddress(value, { strict: false }), "Invalid EVM address").transform((value) => value.toLowerCase()),
  nonce: z.string().regex(/^[A-Za-z0-9]{16,64}$/),
  issued: isoDateTime,
  expires: isoDateTime,
  signature: z.string().regex(/^0x[0-9a-fA-F]{130}$/),
});
export const upcomingItemSchema = z.object({
  id: z.string(), symbol: z.string(), underlying: z.string(),
  curve: z.enum(["squared", "ratio", "cubed", "root", "downside"]),
  name: z.string(), description: z.string(), tags: z.array(z.string()),
  status: z.enum(["soon", "live"]), interest: z.number().int().nonnegative(), subscribed: z.boolean().nullable(),
});
export const upcomingResponseSchema = z.object({ items: z.array(upcomingItemSchema), asOf: isoDateTime });
export const subscribeResponseSchema = z.object({ id: z.string(), interest: z.number().int().nonnegative(), subscribed: z.boolean() });
export const rangeQuery = z.object({ range: z.enum(["1H", "4H", "1D", "1W", "1M", "ALL"]).default("1D"), series: z.enum(["price", "index"]).default("price") });
export const carryRangeQuery = z.object({ range: z.enum(["1W", "1M", "ALL"]).default("1W") });
export const limitQuery = z.object({ limit: z.coerce.number().int().min(1).max(200).default(50) });
export const activityQuery = z.object({ type: z.enum(["all", "trades", "vault"]).default("all"), cursor: z.string().max(512).optional(), limit: z.coerce.number().int().min(1).max(100).default(50) });
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((v) => Number.isFinite(Date.parse(`${v}T00:00:00Z`)), "Invalid date");
export const exportQuery = z.object({
  type: z.enum(["all", "trades", "vault"]).default("all"),
  from: isoDate.optional(),
  to: isoDate.optional(),
}).refine((q) => !q.from || !q.to || q.from <= q.to, "from must not be after to");
export const corpActionsQuery = z.object({ symbol: z.string().min(1).max(16).transform((value) => value.toUpperCase()).optional() });
export const earningsQuery = z.object({ days: z.coerce.number().int().min(1).max(90).default(30) });
export const earningsResponseSchema = z.object({
  asOf: isoDateTime,
  todayEt: z.string(),
  days: z.number().int(),
  items: z.array(z.object({
    symbol: z.string(),
    date: z.string(),
    session: earningsSession,
    confirmed: z.boolean(),
    source: z.enum(["override", "alphavantage"]),
    sourceUrl: z.string().nullable(),
    daysUntil: z.number().int(),
    upcoming: z.boolean(),
    markets: z.array(z.object({
      symbol: z.string(), curve: z.string(), price: decimal, change24hPct: percent, dailyCarryPct: percent,
    })),
  })),
});

const nullablePct = percent.nullable();
export const marketVolSchema = z.object({
  symbol: z.string(), asOf: isoDateTime,
  realized7dPct: nullablePct, realized30dPct: nullablePct, carryImpliedPct: nullablePct,
  annualCarryPct: nullablePct, carryToVariance: z.number().nullable(),
  samples7d: z.number().int().nonnegative(), samples30d: z.number().int().nonnegative(),
  history: z.array(z.object({ t: z.number().int(), realized7dPct: z.number() })),
});
export const marketCurvesResponseSchema = z.object({
  symbol: z.string(),
  underlying: z.string(),
  sigmaAnnualPct: percent.nullable(),
  sigmaSource: z.enum(["realized30d", "realized7d"]).nullable(),
  moves: z.array(z.number().int()),
  asOf: isoDateTime,
  curves: z.array(z.object({
    curve: z.enum(["squared", "cubed", "root", "downside"]),
    exponent: z.number(),
    notation: z.string(),
    displaySymbol: z.string(),
    status: z.enum(["live", "coming", "preview"]),
    marketSymbol: z.string().nullable(),
    payoffs: z.array(z.object({ movePct: z.number().int(), indexPct: percent.nullable() })),
    fairCarryDailyPct: percent.nullable(),
    fairCarryAnnualPct: percent.nullable(),
    carryDirection: z.enum(["holder_pays", "holder_receives", "none"]).nullable(),
    liveDailyCarryPct: percent.nullable(),
  })),
});

export const backtestQuery = z.object({
  days: z.enum(["7", "30"]).default("7").transform((value) => Number(value) as 7 | 30),
});
export const marketBacktestResponseSchema = z.object({
  symbol: z.string(), days: z.union([z.literal(7), z.literal(30)]), available: z.boolean(),
  reason: z.string().optional(), shortened: z.boolean().optional(), actualDays: z.number().int().positive().optional(),
  startAt: isoDateTime.optional(), endAt: isoDateTime.optional(), investUsd: decimal.optional(),
  entryPrice: decimal.optional(), exitPrice: decimal.optional(), tokens: decimal.optional(),
  markValueUsd: decimal.optional(), valueUsd: decimal.optional(), costsUsd: decimal.optional(),
  changePct: percent.optional(), markChangePct: percent.optional(), stockChangePct: percent.optional(),
  carryPct: percent.nullable().optional(),
  points: z.array(z.object({ t: z.number().int(), valueUsd: decimal })),
});
export const marketTokenFlowSchema = z.object({
  symbol: z.string(),
  asOf: isoDateTime,
  todayUsd: decimal.nullable(),
  days: z.array(z.object({ date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), mintBurnUsd: decimal })),
});
export const hottestTokensSchema = z.object({
  asOf: isoDateTime,
  tokens: z.array(z.object({ symbol: z.string(), mintBurnUsd: decimal, listedOnLemniscate: z.boolean() })),
});
export const marketTokenFlowQuery = z.object({
  days: z.enum(["7", "30"]).default("30"),
});
export const hottestTokensQuery = z.object({ limit: z.coerce.number().int().min(1).max(20).default(8) });
export const volBoardResponseSchema = z.object({
  asOf: isoDateTime,
  markets: z.array(marketVolSchema.omit({ asOf: true, history: true })),
});
