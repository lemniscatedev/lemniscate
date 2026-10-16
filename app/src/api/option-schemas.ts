import { z } from "@hono/zod-openapi";
import { isAddress } from "viem";
import { isoDateTime } from "./schemas";

const decimal = z.string().regex(/^-?\d+(?:\.\d+)?$/);
const rawInt = z.string().regex(/^\d+$/);
const speed = z.enum(["DAILY", "WEEKLY"]);
const session = z.enum(["REGULAR", "EXTENDED", "CLOSED", "UNKNOWN", "HALTED"]);
const address = z.string().refine((value) => isAddress(value, { strict: false }), "Invalid EVM address")
  .transform((value) => value.toLowerCase());
const hex32 = z.string().regex(/^0x[0-9a-fA-F]{64}$/).transform((value) => value.toLowerCase());
const hexData = z.string().regex(/^0x[0-9a-fA-F]*$/);

export const buyBlockSchema = z.enum([
  "SERIES_ARCHIVED", "SERIES_NOT_BUYABLE", "BUYS_PAUSED", "SESSION_CLOSED", "SESSION_UNKNOWN", "SESSION_HALTED",
  "PRICE_STALE", "PRICE_PAUSED", "NO_VOL", "VOL_STALE", "EARNINGS_BLOCK", "NO_PRICE", "CAP_REACHED",
]);

export const apiErrorSchema = z.object({ error: z.string(), message: z.string(), reason: buyBlockSchema.optional() });

export const nameParams = z.object({ name: z.string().regex(/^[A-Za-z0-9.]{1,12}$/).transform((value) => value.toUpperCase()) });
export const seriesParams = z.object({ id: hex32 });
export const accountParams = z.object({ address });

// ---------------------------------------------------------------------------------------------------------------
// Chains
// ---------------------------------------------------------------------------------------------------------------

/** One option, priced for ONE option unit. All money is USDG as a decimal string. */
export const chainOptionSchema = z.object({
  id: z.string(),
  isCall: z.boolean(),
  token: z.string(),
  /** What one unit costs to buy now: premium plus spread plus the notional fee. */
  ask: decimal,
  /** What one unit sells for now, after spread and fee. */
  bid: decimal,
  /** Model value before spread. */
  mark: decimal,
  spreadBps: z.number().int(),
  /** Today's holding cost for one unit. */
  dailyCostUsdg: decimal,
  /** "costs about $0.35/day" */
  displayCost: z.string(),
  /** The underlying price at which one unit has paid for itself. */
  breakeven: decimal,
  delta: z.number(),
  gamma: z.number(),
  vega: z.number(),
  sigmaBps: z.number().int(),
  buyable: z.boolean(),
  blockReason: buyBlockSchema.nullable(),
});

export const chainResponseSchema = z.object({
  name: z.string(),
  spot: decimal,
  session,
  asOf: isoDateTime,
  priceUpdatedAt: isoDateTime.nullable(),
  /** True when at least one option can be bought now. */
  buyable: z.boolean(),
  units: z.literal("1"),
  speeds: z.array(z.object({
    speed,
    tauSeconds: z.number().int(),
    sigmaBps: z.number().int().nullable(),
    /** Seconds since the latest vol post for this speed. */
    volAgeSeconds: z.number().int().nullable(),
    volStale: z.boolean(),
    strikes: z.array(z.object({
      strike: decimal,
      /** Strike versus spot, percent (negative: below the current price). */
      moneynessPct: z.number(),
      call: chainOptionSchema.nullable(),
      put: chainOptionSchema.nullable(),
    })),
  })),
});

export const chainListSchema = z.object({
  names: z.array(z.object({ name: z.string(), buyable: z.boolean() })),
});

// ---------------------------------------------------------------------------------------------------------------
// Quote and intents
// ---------------------------------------------------------------------------------------------------------------

const unitsText = z.string().regex(/^\d{1,12}(?:\.\d{1,18})?$/, "units must be a positive decimal number");

export const quoteBodySchema = z.object({
  series: hex32,
  units: unitsText,
  side: z.enum(["buy", "sell"]),
});

/** The fields of IOptionEngine.Quote, as integer strings in the contract's own units. */
export const engineQuoteSchema = z.object({
  usdg: rawInt,
  vMarkWad: rawInt,
  spreadBps: rawInt,
  feeUsdg: rawInt,
  dailyCostUsdg: rawInt,
  breakevenWad: rawInt,
  sigmaBps: rawInt,
  session: z.number().int().min(0).max(4),
  buyable: z.boolean(),
});

export const quoteResponseSchema = z.object({
  series: z.string(),
  side: z.enum(["buy", "sell"]),
  unitsWad: rawInt,
  quote: engineQuoteSchema,
  display: z.object({
    session,
    usdg: decimal,
    feeUsdg: decimal,
    dailyCostUsdg: decimal,
    displayCost: z.string(),
    breakeven: decimal,
    vMark: decimal,
  }),
  blockReason: buyBlockSchema.nullable(),
  sellQueued: z.boolean(),
  asOf: isoDateTime,
});

const slippageBps = z.number().int().min(0).max(1_000).default(50);
const deadlineSeconds = z.number().int().min(30).max(3_600).default(300);

export const buyIntentBodySchema = z.object({
  series: hex32, units: unitsText, account: address, recipient: address.optional(), slippageBps, deadlineSeconds,
  /** One-tap flows: the wallet that owns the smart account `account`. An approved owner counts as an approved account. */
  owner: address.optional(),
});
export const sellIntentBodySchema = buyIntentBodySchema;
export const shieldIntentBodySchema = z.object({
  name: z.string().regex(/^[A-Za-z0-9.]{1,12}$/).transform((value) => value.toUpperCase()),
  tokenUnits: unitsText,
  account: address,
  owner: address.optional(),
  strikePctBelowBps: z.number().int().min(100).max(5_000).default(1_000),
  slippageBps, deadlineSeconds,
});

export const intentResponseSchema = z.object({
  kind: z.enum(["buy", "sell", "shield"]),
  to: z.string(),
  data: hexData,
  value: z.literal("0"),
  approvals: z.array(z.object({ token: z.string(), spender: z.string(), amount: rawInt })),
  /** buy and shield: the most USDG the call may pull (raw, 6 dp). */
  maxCostUsdg: rawInt.optional(),
  /** sell: the least USDG the call may pay out (raw, 6 dp). */
  minProceedsUsdg: rawInt.optional(),
  deadline: z.number().int(),
  series: z.string(),
  /** Option-token amount burned by a sell, raw 18 dp. */
  tokens: rawInt.optional(),
  quote: engineQuoteSchema,
  display: z.object({ usdg: decimal, displayCost: z.string(), breakeven: decimal }),
  /** A sell during a halt: the order queues and fills at the first fresh price. */
  queued: z.boolean(),
  note: z.string().nullable(),
});

// ---------------------------------------------------------------------------------------------------------------
// Series, vol, positions, pool, config
// ---------------------------------------------------------------------------------------------------------------

export const seriesResponseSchema = z.object({
  id: z.string(), name: z.string().nullable(), stock: z.string(), isCall: z.boolean(), speed, tauSeconds: z.number().int(),
  strike: decimal, token: z.string(), norm: decimal, lastAccrual: isoDateTime, buyable: z.boolean(), archived: z.boolean(),
  listedAt: isoDateTime,
  option: chainOptionSchema.nullable(),
  normHistory: z.array(z.object({ ts: isoDateTime, norm: decimal, vMark: decimal, payoff: decimal, session: z.string() })),
});

const volPostSchema = z.object({
  speed, sigmaBps: z.number().int(), skewK: z.string(), eventBumpBps: z.number().int(),
  buyBlockFrom: isoDateTime.nullable(), buyBlockTo: isoDateTime.nullable(), validUntil: isoDateTime, ts: isoDateTime,
});
export const volResponseSchema = z.object({
  name: z.string(),
  asOf: isoDateTime,
  spot: decimal,
  session,
  speeds: z.array(z.object({
    speed,
    latest: volPostSchema.extend({ stale: z.boolean(), ageSeconds: z.number().int(), secondsToExpiry: z.number().int() }).nullable(),
  })),
  history: z.array(volPostSchema),
});

export const positionsResponseSchema = z.object({
  account: z.string(),
  asOf: isoDateTime,
  positions: z.array(z.object({
    seriesId: z.string(), name: z.string().nullable(), isCall: z.boolean(), speed, strike: decimal, token: z.string(),
    balance: decimal, norm: decimal,
    /** balance x norm: the units held after funding. */
    units: decimal,
    valueAtBidUsdg: decimal.nullable(),
    dailyCostUsdg: decimal.nullable(),
    displayCost: z.string().nullable(),
    /** Total paid in on this series, from the trade history. */
    costBasisUsdg: decimal,
    /** Total received from selling this series. */
    proceedsUsdg: decimal,
    /** Value at bid plus proceeds minus cost basis. */
    pnlUsdg: decimal.nullable(),
    session: session.nullable(),
    sellQueued: z.boolean(),
  })),
  totals: z.object({ valueAtBidUsdg: decimal, dailyCostUsdg: decimal, costBasisUsdg: decimal, pnlUsdg: decimal }),
  queuedSells: z.array(z.object({ ticket: z.string(), seriesId: z.string(), tokens: z.string(), queuedAt: isoDateTime })),
});

export const poolResponseSchema = z.object({
  asOf: isoDateTime.nullable(),
  nav: decimal,
  navPerShare: decimal,
  usdg: decimal,
  hedgeEquity: decimal,
  optionLiability: decimal,
  reserve: decimal,
  /** Funding that moved from option holders to the pool over the window, estimated from norm changes. */
  fundingReceived: z.object({ windowHours: z.number().int(), usdg: decimal, estimate: z.literal(true) }),
  /** netDelta, netGamma and netVega are the OUTSTANDING OPTIONS' Greeks (the holders' long side, as the engine's netGreeks
   * returns them); the pool is short exactly these. stressLossBps is computed on the pool's side. */
  exposures: z.array(z.object({
    name: z.string(), netDelta: decimal, netGamma: decimal, netVega: decimal, deltaNotionalUsdg: decimal,
    stressLossBps: decimal, outstandingValueUsdg: decimal, outstandingPctOfNav: z.number().nullable(),
  })),
  stressLossBps: decimal,
  caps: z.object({
    navCapUsdg: decimal, navPctOfCap: z.number().nullable(),
    totalOptionValuePct: z.number().nullable(), totalOptionValueCapPct: z.number(),
    perNameCapPct: z.number(), perSeriesCapUsdg: decimal, largestSeriesValueUsdg: decimal,
    stressBudgetPct: z.number(), perAccountSeriesCapUsdg: decimal,
  }),
  hedgeEquityAgeSeconds: z.number().int().nullable(),
  drawdown30dPct: z.number().nullable(),
  drawdownPausePct: z.number(),
  queue: z.object({ withdrawals: z.number().int(), withdrawalShares: decimal, sells: z.number().int() }),
  buysPaused: z.boolean(),
});

export const configResponseSchema = z.object({
  chainId: z.number().int(),
  network: z.enum(["mainnet", "fork", "testnet"]),
  forkProof: z.object({ blockNumber: z.number().int().nonnegative(), blockHash: z.string() }).optional(),
  contracts: z.record(z.string(), z.string()),
  stocks: z.array(z.object({ name: z.string(), stock: z.string(), feed: z.string().nullable() })),
  names: z.array(z.string()),
  usdgDecimals: z.literal(6),
  optionDecimals: z.literal(18),
  poolShareDecimals: z.number().int(),
  speeds: z.array(z.object({ speed, tauSeconds: z.number().int() })),
  caps: z.object({
    poolNavUsdg: decimal, perSeriesOutstandingUsdg: decimal, perAccountSeriesUsdg: decimal,
    totalOptionValuePctOfNav: z.number(), perNamePctOfNav: z.number(), stressBudgetPctOfNav: z.number(),
    drawdownPausePct: z.number(), writerVaultsOpen: z.boolean(),
  }),
  pricing: z.object({
    feeBps: z.number(), minSpreadUsd: z.number(), spreadBpsAtm: z.number(), spreadBpsFar: z.number(),
    sessionMultipliers: z.record(z.string(), z.number()),
  }),
});

// ---------------------------------------------------------------------------------------------------------------
// Account activity, agents and smart account (todo 15b)
// ---------------------------------------------------------------------------------------------------------------

export const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().max(512).optional(),
});

export const activityItemSchema = z.object({
  kind: z.enum([
    "buy", "sell", "shield", "sell_queued", "sell_filled", "sell_cancelled", "pool_deposit", "pool_withdraw",
    "withdraw_requested", "withdraw_claimed", "agent_buy", "agent_sell",
  ]),
  ts: isoDateTime,
  block: rawInt,
  txHash: z.string(),
  logIndex: z.number().int(),
  seriesId: z.string().nullable(),
  name: z.string().nullable(),
  isCall: z.boolean().nullable(),
  speed: speed.nullable(),
  strike: decimal.nullable(),
  usdg: decimal.nullable(),
  amount: decimal.nullable(),
  ticket: rawInt.nullable(),
  agent: z.string().nullable(),
  filler: z.string().nullable(),
  status: z.enum(["open", "filled", "cancelled"]).nullable(),
});

export const activityResponseSchema = z.object({
  account: z.string(),
  items: z.array(activityItemSchema),
  /** Pass as `cursor` for the next older page; null when there is none. */
  nextCursor: z.string().nullable(),
});

export const agentTradeSchema = z.object({
  txHash: z.string(), logIndex: z.number().int(), ts: isoDateTime, agent: z.string(), seriesId: z.string(),
  name: z.string().nullable(), isCall: z.boolean().nullable(), speed: speed.nullable(), strike: decimal.nullable(),
  side: z.enum(["buy", "sell"]), usdg: decimal,
});

export const agentSchema = z.object({
  agent: z.string(),
  budgetUsdg: decimal,
  maxPerTradeUsdg: decimal,
  /** Buys by this agent counted against the budget, from indexed AgentTrade events. */
  spentUsdg: decimal,
  remainingBudgetUsdg: decimal,
  expiresAt: isoDateTime,
  canSell: z.boolean(),
  canShield: z.boolean(),
  /** Names the policy allows (from PolicyStocks); name is null when the indexer has no series for that stock. */
  allowedStocks: z.array(z.object({ stock: z.string(), name: z.string().nullable() })),
  setAt: isoDateTime,
  revoked: z.boolean(),
  revokedAt: isoDateTime.nullable(),
  expired: z.boolean(),
  /** Not revoked and not expired. */
  active: z.boolean(),
  tradeCount: z.number().int(),
  recentTrades: z.array(agentTradeSchema),
});

export const agentsResponseSchema = z.object({
  account: z.string(),
  asOf: isoDateTime,
  agents: z.array(agentSchema),
});

export const smartAccountQuery = z.object({ index: z.coerce.number().int().min(0).max(0xffff_ffff).default(0) });

export const smartAccountResponseSchema = z.object({
  owner: z.string(),
  accountIndex: z.number().int(),
  /** The Kernel v3.3 account this owner gets (or already has) at this index. Counterfactual until the first operation. */
  address: z.string(),
  /** true once the indexer has seen the account on chain; null when it has not (not deployed, or not indexed yet). */
  deployed: z.boolean().nullable(),
  chainId: z.number().int(),
  factory: z.string(),
  validator: z.string(),
  entryPoint: z.string(),
});
