import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  smallint,
  text,
  timestamp,
  uniqueIndex,
} from "drizzle-orm/pg-core";

// On-chain addresses are normalized to lowercase before they reach this schema.
// Amounts are human-unit decimal values: USDG/1e6, OptionTokens/1e18, LWP/1e12,
// and WAD values/1e18. Drizzle's numeric columns intentionally stay strings.
const amount = (name: string) => numeric(name, { precision: 78, scale: 18 });
const at = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });
const chainBlock = (name = "block") => bigint(name, { mode: "bigint" });

export const markets = pgTable(
  "markets",
  {
    id: smallint("id").primaryKey(),
    symbol: text("symbol").notNull(),
    token: text("token").notNull(),
    stock: text("stock").notNull(),
    feed: text("feed").notNull(),
    scale: numeric("scale", { precision: 78, scale: 0 }).notNull(),
    poolFee: integer("pool_fee").notNull(),
    listedBlock: chainBlock("listed_block").notNull(),
    config: jsonb("config").$type<Record<string, unknown>>().notNull(),
    updatedAt: at("updated_at").notNull().defaultNow(),
  },
  (table) => [uniqueIndex("markets_symbol_uq").on(table.symbol)],
);

export const ticks = pgTable(
  "ticks",
  {
    marketId: smallint("market_id").notNull(),
    ts: at("ts").notNull(),
    block: chainBlock().notNull(),
    spot: amount("spot").notNull(),
    index: amount("index").notNull(),
    normFactor: amount("norm_factor").notNull(),
    price: amount("price").notNull(),
    bid: amount("bid").notNull(),
    ask: amount("ask").notNull(),
    carryWad: amount("carry_wad").notNull(),
    regime: smallint("regime").notNull(),
    buysPaused: boolean("buys_paused").notNull().default(false),
    vaultShort: amount("vault_short").notNull(),
    liability: amount("liability").notNull(),
    hedgeUnits: amount("hedge_units").notNull(),
    hedgeTarget: amount("hedge_target").notNull().default("0"),
    oracleUpdatedAt: at("oracle_updated_at").notNull(),
  },
  (table) => [
    primaryKey({ name: "ticks_pk", columns: [table.marketId, table.ts] }),
    index("ticks_market_ts_idx").on(table.marketId, table.ts.desc()),
  ],
);

export const trades = pgTable(
  "trades",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    block: chainBlock().notNull(),
    ts: at("ts").notNull(),
    marketId: smallint("market_id").notNull(),
    account: text("account").notNull(),
    recipient: text("recipient").notNull(),
    side: text("side").notNull(),
    usdg: amount("usdg").notNull(),
    fee: amount("fee").notNull(),
    tokens: amount("tokens").notNull(),
    price: amount("price").notNull(),
    index: amount("index").notNull(),
    normFactor: amount("norm_factor").notNull(),
  },
  (table) => [
    primaryKey({ name: "trades_pk", columns: [table.txHash, table.logIndex] }),
    index("trades_account_ts_idx").on(table.account, table.ts.desc()),
    index("trades_market_ts_idx").on(table.marketId, table.ts.desc()),
    index("trades_recipient_ts_idx").on(table.recipient, table.ts.desc()),
  ],
);

// OptionToken and LWP transfers share one event table. market_id is null for LWP;
// token identifies the asset in both cases and allows balances to be rebuilt.
export const transfers = pgTable(
  "transfers",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    block: chainBlock().notNull(),
    ts: at("ts").notNull(),
    marketId: smallint("market_id"),
    token: text("token").notNull(),
    fromAddr: text("from_addr").notNull(),
    toAddr: text("to_addr").notNull(),
    amount: amount("amount").notNull(),
  },
  (table) => [
    primaryKey({ name: "transfers_pk", columns: [table.txHash, table.logIndex] }),
    index("transfers_from_ts_idx").on(table.fromAddr, table.ts.desc()),
    index("transfers_to_ts_idx").on(table.toAddr, table.ts.desc()),
    index("transfers_token_account_idx").on(table.token, table.toAddr),
  ],
);

export const vaultEvents = pgTable(
  "vault_events",
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
    primaryKey({ name: "vault_events_pk", columns: [table.txHash, table.logIndex] }),
    index("vault_events_account_ts_idx").on(table.account, table.ts.desc()),
    index("vault_events_kind_ts_idx").on(table.kind, table.ts.desc()),
  ],
);

// Current account metadata is chain-derived and contains no user supplied PII.
export const accountMetadata = pgTable("account_metadata", {
  address: text("address").primaryKey(),
  firstSeenBlock: chainBlock("first_seen_block").notNull(),
  firstSeenAt: at("first_seen_at").notNull(),
  lastSeenBlock: chainBlock("last_seen_block").notNull(),
  lastActivityAt: at("last_activity_at").notNull(),
});

// Snapshots of allowlist and share-lock state let the API serve account views without RPC.
export const vaultAccountState = pgTable("vault_account_state", {
  account: text("account").primaryKey(),
  isDepositor: boolean("is_depositor").notNull(),
  unlockTime: at("unlock_time"),
  updatedBlock: chainBlock("updated_block").notNull(),
  updatedAt: at("updated_at").notNull().defaultNow(),
});

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

export const oracleUpdates = pgTable(
  "oracle_updates",
  {
    marketId: smallint("market_id").notNull(),
    ts: at("ts").notNull(),
    roundId: numeric("round_id", { precision: 78, scale: 0 }).notNull(),
    answer: amount("answer").notNull(),
    block: chainBlock().notNull(),
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
  },
  (table) => [
    primaryKey({ name: "oracle_updates_pk", columns: [table.txHash, table.logIndex] }),
    index("oracle_updates_market_ts_idx").on(table.marketId, table.ts.desc()),
  ],
);

export const vaultTicks = pgTable(
  "vault_ticks",
  {
    ts: at("ts").primaryKey(),
    block: chainBlock().notNull(),
    nav: amount("nav").notNull(),
    totalAssets: amount("total_assets").notNull(),
    totalSupply: amount("total_supply").notNull(),
    navPerShare: amount("nav_per_share").notNull(),
    usdg: amount("usdg").notNull(),
    totalLiability: amount("total_liability").notNull(),
    maxGlobalExposureBps: integer("max_global_exposure_bps").notNull(),
    publicDeposits: boolean("public_deposits").notNull(),
    depositCapRemaining: amount("deposit_cap_remaining").notNull(),
  },
);

export const hedges = pgTable(
  "hedges",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    block: chainBlock().notNull(),
    ts: at("ts").notNull(),
    marketId: smallint("market_id").notNull(),
    isBuy: boolean("is_buy").notNull(),
    amountIn: amount("amount_in").notNull(),
    amountOut: amount("amount_out").notNull(),
    hedgeUnitsAfter: amount("hedge_units_after").notNull(),
  },
  (table) => [
    primaryKey({ name: "hedges_pk", columns: [table.txHash, table.logIndex] }),
    index("hedges_market_ts_idx").on(table.marketId, table.ts.desc()),
  ],
);

export const regimeLog = pgTable(
  "regime_log",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    marketId: smallint("market_id").notNull(),
    ts: at("ts").notNull(),
    fromRegime: smallint("from_regime").notNull(),
    toRegime: smallint("to_regime").notNull(),
    block: chainBlock().notNull(),
  },
  (table) => [
    primaryKey({ name: "regime_log_pk", columns: [table.txHash, table.logIndex] }),
    index("regime_log_market_ts_idx").on(table.marketId, table.ts.desc()),
  ],
);

export const carryUpdates = pgTable(
  "carry_updates",
  {
    txHash: text("tx_hash").notNull(),
    logIndex: integer("log_index").notNull(),
    marketId: smallint("market_id").notNull(),
    ts: at("ts").notNull(),
    baseCarryWad: amount("base_carry_wad").notNull(),
  },
  (table) => [
    primaryKey({ name: "carry_updates_pk", columns: [table.txHash, table.logIndex] }),
    index("carry_updates_market_ts_idx").on(table.marketId, table.ts.desc()),
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
