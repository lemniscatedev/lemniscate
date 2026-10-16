import { sql } from "drizzle-orm";
import {
  bigint,
  bigserial,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// On-chain addresses are normalized to lowercase before they reach this schema.
// Amounts are human-unit decimal values: USDG/1e6, option tokens/1e18, pool shares/10^poolShareDecimals,
// and WAD values/1e18. Drizzle's numeric columns intentionally stay strings.
const amount = (name: string) => numeric(name, { precision: 78, scale: 18 });
const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const chainBlock = (name = "block") => bigint(name, { mode: "bigint" });

export const accountMetadata = pgTable("account_metadata", {
  address: text("address").primaryKey(),
  firstSeenBlock: chainBlock("first_seen_block").notNull(),
  firstSeenAt: at("first_seen_at").notNull(),
  lastSeenBlock: chainBlock("last_seen_block").notNull(),
  lastActivityAt: at("last_activity_at").notNull(),
});

// Snapshots of allowlist and share-lock state let the API serve account views without RPC.

export const balances = pgTable(
  "balances",
  {
    token: text("token").notNull(),
    account: text("account").notNull(),
    balance: amount("balance").notNull(),
    updatedBlock: chainBlock("updated_block").notNull(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "balances_pk", columns: [table.token, table.account] }),
    index("balances_account_idx").on(table.account),
  ],
);

export const corpActions = pgTable(
  "corp_actions",
  {
    id: text("id").primaryKey(),
    symbol: text("symbol").notNull(),
    kind: text("kind").notNull(),
    status: text("status").notNull(),
    processDate: date("process_date", { mode: "date" }),
    effectiveAt: at("effective_at"),
    oldMult: amount("old_mult"),
    newMult: amount("new_mult"),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    source: text("source").notNull(),
    verifiedContinuity: boolean("verified_continuity"),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (table) => [index("corp_actions_symbol_effective_idx").on(table.symbol, table.effectiveAt)],
);

export const refPrices = pgTable(
  "ref_prices",
  {
    stock: text("stock").primaryKey(),
    symbol: text("symbol").notNull(),
    bid: amount("bid"),
    ask: amount("ask"),
    tokenBid: amount("token_bid"),
    tokenAsk: amount("token_ask"),
    dailyHigh: amount("daily_high"),
    dailyLow: amount("daily_low"),
    dailyVolume: amount("daily_volume"),
    mintBurnUsd: amount("mint_burn_usd"),
    halt: boolean("halt").notNull().default(false),
    generatedAt: at("generated_at").notNull(),
    fetchedAt: at("fetched_at").notNull().defaultNow(),
  },
  (table) => [index("ref_prices_symbol_idx").on(table.symbol)],
);

export const tokenFlow = pgTable(
  "token_flow",
  {
    stock: text("stock").notNull(),
    flowDate: date("flow_date", { mode: "string" }).notNull(),
    symbol: text("symbol").notNull(),
    mintBurnUsd: amount("mint_burn_usd").notNull(),
    firstSeenAt: at("first_seen_at").notNull(),
    updatedAt: at("updated_at").notNull(),
  },
  (table) => [
    primaryKey({ name: "token_flow_pk", columns: [table.stock, table.flowDate] }),
    index("token_flow_date_idx").on(table.flowDate.desc()),
  ],
);

export const marketLaunch = pgTable("market_launch", {
  symbol: text("symbol").primaryKey(),
  launched: boolean("launched").notNull(),
  updatedAt: at("updated_at").notNull().defaultNow(),
  note: text("note"),
});

export const upcomingSubscriptions = pgTable(
  "upcoming_subscriptions",
  {
    upcomingId: text("upcoming_id").notNull(),
    address: text("address").notNull(),
    createdAt: at("created_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "upcoming_subscriptions_pk", columns: [table.upcomingId, table.address] }),
    index("upcoming_subscriptions_address_idx").on(table.address),
  ],
);

export const apiNonces = pgTable(
  "api_nonces",
  {
    address: text("address").notNull(),
    nonce: text("nonce").notNull(),
    action: text("action").notNull(),
    expiresAt: at("expires_at").notNull(),
  },
  (table) => [
    primaryKey({ name: "api_nonces_pk", columns: [table.address, table.nonce] }),
    index("api_nonces_expires_idx").on(table.expiresAt),
  ],
);

export const earnings = pgTable(
  "earnings",
  {
    symbol: text("symbol").notNull(),
    reportDate: date("report_date", { mode: "string" }).notNull(),
    session: text("session").notNull().default("unknown"),
    fiscalDateEnding: date("fiscal_date_ending", { mode: "string" }),
    source: text("source").notNull(),
    fetchedAt: at("fetched_at").notNull().defaultNow(),
  },
  (table) => [
    primaryKey({ name: "earnings_pk", columns: [table.symbol, table.reportDate, table.source] }),
    index("earnings_date_idx").on(table.reportDate),
  ],
);

export const cursors = pgTable("cursors", {
  name: text("name").primaryKey(),
  block: chainBlock().notNull(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

export const keeperStatus = pgTable("keeper_status", {
  job: text("job").primaryKey(),
  lastRun: at("last_run"),
  lastOk: at("last_ok"),
  lastError: text("last_error"),
  lastTx: text("last_tx"),
  meta: jsonb("meta").$type<Record<string, unknown>>().notNull().default({}),
});

export const series = pgTable(
  "series",
  {
    id: text("id").primaryKey(),
    stockToken: text("stock_token").notNull(),
    name: text("name"),
    feed: text("feed"),
    isCall: boolean("is_call").notNull(),
    speed: text("speed").notNull(),
    tauS: integer("tau_s").notNull(),
    strike: amount("strike").notNull(),
    token: text("token").notNull(),
    norm: amount("norm").notNull().default("1"),
    lastAccrual: at("last_accrual").notNull(),
    buyable: boolean("buyable").notNull().default(false),
    archived: boolean("archived").notNull().default(false),
    listedAt: at("listed_at").notNull(),
    listedBlock: chainBlock("listed_block").notNull(),
    listedTx: text("listed_tx").notNull(),
    listedLog: integer("listed_log").notNull(),
  },
  (table) => [
    uniqueIndex("series_token_uq").on(table.token),
    index("series_stock_idx").on(table.stockToken, table.isCall, table.speed, table.strike),
    index("series_name_idx").on(table.name),
  ],
);

export const seriesFlagLog = pgTable(
  "series_flag_log",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    block: chainBlock().notNull(),
    ts: at("ts").notNull(),
    seriesId: text("series_id").notNull(),
    kind: text("kind").notNull(),
    value: boolean("value").notNull(),
  },
  (table) => [primaryKey({ name: "series_flag_log_pk", columns: [table.txHash, table.logIndex, table.kind] })],
);

// USDG columns hold 6 dp values, option units and prices WAD values, option-token amounts 18 dp values.
export const trades = pgTable(
  "trades",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    block: chainBlock().notNull(),
    ts: at("ts").notNull(),
    seriesId: text("series_id").notNull(),
    account: text("account").notNull(),
    recipient: text("recipient").notNull(),
    side: text("side").notNull(),
    units: amount("units").notNull(),
    shares: amount("shares").notNull(),
    usdg: amount("usdg").notNull(),
    vMark: amount("v_mark").notNull(),
    sigmaBps: integer("sigma_bps").notNull(),
    session: text("session").notNull(),
  },
  (table) => [
    primaryKey({ name: "trades_pk", columns: [table.txHash, table.logIndex] }),
    index("trades_account_ts_idx").on(table.account, table.ts.desc()),
    index("trades_recipient_ts_idx").on(table.recipient, table.ts.desc()),
    index("trades_series_ts_idx").on(table.seriesId, table.ts.desc()),
    index("trades_block_idx").on(table.block),
  ],
);

export const shields = pgTable(
  "shields",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    block: chainBlock().notNull(),
    ts: at("ts").notNull(),
    account: text("account").notNull(),
    stockToken: text("stock_token").notNull(),
    seriesId: text("series_id").notNull(),
    tokenUnits: amount("token_units").notNull(),
    usdgPaid: amount("usdg_paid").notNull(),
  },
  (table) => [
    primaryKey({ name: "shields_pk", columns: [table.txHash, table.logIndex] }),
    index("shields_account_ts_idx").on(table.account, table.ts.desc()),
    index("shields_block_idx").on(table.block),
  ],
);

export const agentTrades = pgTable(
  "agent_trades",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    block: chainBlock().notNull(),
    ts: at("ts").notNull(),
    owner: text("owner").notNull(),
    agent: text("agent").notNull(),
    seriesId: text("series_id").notNull(),
    isBuy: boolean("is_buy").notNull(),
    usdg: amount("usdg").notNull(),
  },
  (table) => [
    primaryKey({ name: "agent_trades_pk", columns: [table.txHash, table.logIndex] }),
    index("agent_trades_owner_ts_idx").on(table.owner, table.ts.desc()),
    index("agent_trades_owner_agent_idx").on(table.owner, table.agent, table.ts.desc()),
    index("agent_trades_block_idx").on(table.block),
  ],
);

export const agentPolicyEvents = pgTable(
  "agent_policy_events",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    block: chainBlock().notNull(),
    ts: at("ts").notNull(),
    kind: text("kind").notNull(),
    owner: text("owner").notNull(),
    agent: text("agent").notNull(),
    budgetUsdg: amount("budget_usdg"),
    maxPerTradeUsdg: amount("max_per_trade_usdg"),
    expiresAt: at("expires_at"),
    canSell: boolean("can_sell"),
    canShield: boolean("can_shield"),
  },
  (table) => [
    primaryKey({ name: "agent_policy_events_pk", columns: [table.txHash, table.logIndex] }),
    index("agent_policy_events_owner_idx").on(table.owner, table.agent, table.block.desc(), table.logIndex.desc()),
    index("agent_policy_events_block_idx").on(table.block),
  ],
);

// TimescaleDB hypertable on ts.
export const normHistory = pgTable(
  "norm_history",
  {
    seriesId: text("series_id").notNull(),
    ts: at("ts").notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    block: chainBlock().notNull(),
    norm: amount("norm").notNull(),
    vMark: amount("v_mark").notNull(),
    payoff: amount("payoff").notNull(),
    session: text("session").notNull(),
  },
  (table) => [
    primaryKey({ name: "norm_history_pk", columns: [table.seriesId, table.ts, table.txHash, table.logIndex] }),
    index("norm_history_block_idx").on(table.block),
  ],
);

// TimescaleDB hypertable on ts (90 day retention).
export const ticks = pgTable(
  "ticks",
  {
    stockToken: text("stock_token").notNull(),
    name: text("name"),
    ts: at("ts").notNull(),
    block: chainBlock().notNull(),
    spot: amount("spot").notNull(),
    session: text("session").notNull(),
    fresh: boolean("fresh").notNull(),
    buysPaused: boolean("buys_paused").notNull().default(false),
    priceUpdatedAt: at("price_updated_at"),
    sigmaDailyBps: integer("sigma_daily_bps"),
    sigmaWeeklyBps: integer("sigma_weekly_bps"),
    volStale: boolean("vol_stale"),
  },
  (table) => [
    primaryKey({ name: "ticks_pk", columns: [table.stockToken, table.ts] }),
    index("ticks_block_idx").on(table.block),
  ],
);

export const volPosts = pgTable(
  "vol_posts",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    block: chainBlock().notNull(),
    ts: at("ts").notNull(),
    stockToken: text("stock_token").notNull(),
    name: text("name"),
    speed: text("speed").notNull(),
    sigmaBps: integer("sigma_bps").notNull(),
    skewK: numeric("skew_k", { precision: 78, scale: 0 }).notNull(),
    eventBumpBps: integer("event_bump_bps").notNull(),
    buyBlockFrom: at("buy_block_from"),
    buyBlockTo: at("buy_block_to"),
    validUntil: at("valid_until").notNull(),
    nonce: numeric("nonce", { precision: 78, scale: 0 }).notNull(),
    sig: text("sig"),
  },
  (table) => [
    primaryKey({ name: "vol_posts_pk", columns: [table.txHash, table.logIndex] }),
    index("vol_posts_stock_ts_idx").on(table.stockToken, table.speed, table.ts.desc()),
    index("vol_posts_block_idx").on(table.block),
  ],
);

// What the vol-engine signed and whether it was sent (the indexer owns vol_posts, the on-chain events).
export const volPostIntents = pgTable(
  "vol_post_intents",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    createdAt: at("created_at").notNull().defaultNow(),
    stockToken: text("stock_token").notNull(),
    name: text("name"),
    speed: text("speed").notNull(),
    sigmaBps: integer("sigma_bps").notNull(),
    skewK: numeric("skew_k", { precision: 78, scale: 0 }).notNull(),
    eventBumpBps: integer("event_bump_bps").notNull(),
    buyBlockFrom: at("buy_block_from"),
    buyBlockTo: at("buy_block_to"),
    validUntil: at("valid_until").notNull(),
    nonce: numeric("nonce", { precision: 78, scale: 0 }).notNull(),
    digest: text("digest").notNull(),
    sig: text("sig").notNull(),
    status: text("status").notNull(),
    txHash: text("tx_hash"),
    flags: jsonb("flags").$type<string[]>().notNull().default(sql`'[]'::jsonb`),
  },
  (table) => [
    uniqueIndex("vol_post_intents_nonce_uq").on(table.stockToken, table.speed, table.nonce),
    index("vol_post_intents_stock_idx").on(table.stockToken, table.speed, table.createdAt.desc()),
  ],
);

export const volAlerts = pgTable(
  "vol_alerts",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    ts: at("ts").notNull().defaultNow(),
    name: text("name").notNull(),
    kind: text("kind").notNull(),
    detail: jsonb("detail").$type<Record<string, unknown>>().notNull().default(sql`'{}'::jsonb`),
  },
  (table) => [index("vol_alerts_name_kind_idx").on(table.name, table.kind, table.ts.desc())],
);

// TimescaleDB hypertable on ts.
export const poolNav = pgTable(
  "pool_nav",
  {
    ts: at("ts").primaryKey(),
    block: chainBlock().notNull(),
    usdg: amount("usdg").notNull(),
    hedgeEquity: amount("hedge_equity").notNull(),
    optionLiability: amount("option_liability").notNull(),
    reserve: amount("reserve").notNull(),
    nav: amount("nav").notNull(),
    navPerShare: amount("nav_per_share").notNull(),
  },
  (table) => [index("pool_nav_block_idx").on(table.block)],
);

export const limitsState = pgTable(
  "limits_state",
  {
    name: text("name").notNull(),
    ts: at("ts").notNull(),
    block: chainBlock().notNull(),
    stockToken: text("stock_token").notNull(),
    netDelta: amount("net_delta").notNull(),
    netGamma: amount("net_gamma").notNull(),
    netVega: amount("net_vega").notNull(),
    stressLossBps: numeric("stress_loss_bps", { precision: 20, scale: 4 }).notNull(),
  },
  (table) => [
    primaryKey({ name: "limits_state_pk", columns: [table.name, table.ts] }),
    index("limits_state_block_idx").on(table.block),
  ],
);

// Written by the hedger, not the indexer.
export const hedges = pgTable(
  "hedges",
  {
    id: bigserial("id", { mode: "bigint" }).primaryKey(),
    venue: text("venue").notNull(),
    name: text("name").notNull(),
    side: text("side").notNull(),
    qty: amount("qty").notNull(),
    px: amount("px").notNull(),
    ts: at("ts").notNull(),
    venueRef: text("venue_ref"),
  },
  (table) => [
    uniqueIndex("hedges_venue_ref_uq").on(table.venue, table.venueRef).where(sql`${table.venueRef} IS NOT NULL`),
    index("hedges_name_ts_idx").on(table.name, table.ts.desc()),
  ],
);

export const queuedSells = pgTable(
  "queued_sells",
  {
    ticket: numeric("ticket", { precision: 78, scale: 0 }).primaryKey(),
    seriesId: text("series_id").notNull(),
    seller: text("seller").notNull(),
    recipient: text("recipient").notNull(),
    tokens: amount("tokens").notNull(),
    queuedAt: at("queued_at").notNull(),
    queuedBlock: chainBlock("queued_block").notNull(),
    queuedTx: text("queued_tx").notNull(),
    queuedLog: integer("queued_log").notNull(),
    status: text("status").notNull().default("open"),
    closedAt: at("closed_at"),
    closedBlock: chainBlock("closed_block"),
    closedTx: text("closed_tx"),
    closedLog: integer("closed_log"),
    filler: text("filler"),
    usdgOut: amount("usdg_out"),
  },
  (table) => [
    index("queued_sells_seller_idx").on(table.seller, table.queuedAt.desc()),
    index("queued_sells_block_idx").on(table.queuedBlock),
  ],
);

export const withdrawals = pgTable(
  "withdrawals",
  {
    owner: text("owner").notNull(),
    ticket: numeric("ticket", { precision: 78, scale: 0 }).notNull(),
    shares: amount("shares").notNull(),
    claimableAt: at("claimable_at").notNull(),
    queuedAt: at("queued_at").notNull(),
    queuedBlock: chainBlock("queued_block").notNull(),
    queuedTx: text("queued_tx").notNull(),
    queuedLog: integer("queued_log").notNull(),
    status: text("status").notNull().default("queued"),
    claimedAt: at("claimed_at"),
    claimedBlock: chainBlock("claimed_block"),
    claimedTx: text("claimed_tx"),
    claimedLog: integer("claimed_log"),
    usdg: amount("usdg"),
  },
  (table) => [
    primaryKey({ name: "withdrawals_pk", columns: [table.owner, table.ticket] }),
    index("withdrawals_status_idx").on(table.status, table.claimableAt),
    index("withdrawals_block_idx").on(table.queuedBlock),
  ],
);

export const poolEvents = pgTable(
  "pool_events",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    block: chainBlock().notNull(),
    ts: at("ts").notNull(),
    kind: text("kind").notNull(),
    account: text("account").notNull(),
    sender: text("sender"),
    receiver: text("receiver"),
    assets: amount("assets").notNull(),
    shares: amount("shares").notNull(),
  },
  (table) => [
    primaryKey({ name: "pool_events_pk", columns: [table.txHash, table.logIndex] }),
    index("pool_events_account_ts_idx").on(table.account, table.ts.desc()),
    index("pool_events_block_idx").on(table.block),
  ],
);

export const hedgeEquityPosts = pgTable(
  "hedge_equity_posts",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    block: chainBlock().notNull(),
    ts: at("ts").notNull(),
    equityUsdg: amount("equity_usdg").notNull(),
    asOf: at("as_of").notNull(),
    ref: text("ref").notNull(),
  },
  (table) => [
    primaryKey({ name: "hedge_equity_posts_pk", columns: [table.txHash, table.logIndex] }),
    index("hedge_equity_posts_ts_idx").on(table.ts.desc()),
    index("hedge_equity_posts_block_idx").on(table.block),
  ],
);

export const pauseLog = pgTable(
  "pause_log",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    block: chainBlock().notNull(),
    ts: at("ts").notNull(),
    scope: text("scope").notNull(),
    key: text("key").notNull(),
    paused: boolean("paused").notNull(),
    reason: text("reason"),
  },
  (table) => [
    primaryKey({ name: "pause_log_pk", columns: [table.txHash, table.logIndex] }),
    index("pause_log_block_idx").on(table.block),
  ],
);

// Option-token and pool-share transfers, mints and burns included.
export const transfers = pgTable(
  "transfers",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    block: chainBlock().notNull(),
    ts: at("ts").notNull(),
    seriesId: text("series_id"),
    token: text("token").notNull(),
    fromAddr: text("from_addr").notNull(),
    toAddr: text("to_addr").notNull(),
    amount: amount("amount").notNull(),
  },
  (table) => [
    primaryKey({ name: "transfers_pk", columns: [table.txHash, table.logIndex] }),
    index("transfers_from_ts_idx").on(table.fromAddr, table.ts.desc()),
    index("transfers_to_ts_idx").on(table.toAddr, table.ts.desc()),
    index("transfers_token_from_idx").on(table.token, table.fromAddr),
    index("transfers_token_to_idx").on(table.token, table.toAddr),
    index("transfers_block_idx").on(table.block),
  ],
);

// Written by the receipts keeper job.
export const receipts = pgTable("receipts", {
  periodStart: at("period_start").primaryKey(),
  periodEnd: at("period_end").notNull(),
  root: text("root").notNull(),
  leafCount: integer("leaf_count").notNull(),
  tradesCount: integer("trades_count").notNull().default(0),
  volPostsCount: integer("vol_posts_count").notNull().default(0),
  navCount: integer("nav_count").notNull().default(0),
  txHash: text("tx_hash"),
  block: chainBlock("block"),
  createdAt: at("created_at").notNull().defaultNow(),
});

// Recently ingested block hashes, for reorg detection.
export const blockHashes = pgTable("block_hashes", {
  block: chainBlock("block").primaryKey(),
  hash: text("hash").notNull(),
  parentHash: text("parent_hash").notNull(),
  ts: at("ts").notNull(),
});
