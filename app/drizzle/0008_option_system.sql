-- Everlasting option system (replaces the power-payoff product's tables).
--
-- Part 1 retires the old product's tables and the Timescale aggregates built on them. Nothing of the old product was
-- ever deployed, so no data is carried over. Tables that keep their name and meaning (account_metadata, cursors,
-- keeper_status, corp_actions, earnings, ref_prices, token_flow, market_launch, upcoming_subscriptions, api_nonces) are
-- left alone; `balances` keeps its shape but is emptied because every token address it held is gone.
--
-- Part 2 creates the spec's data model (Backend spec section 5) plus the event logs the indexer needs to stay
-- idempotent and reorg safe. Amounts are decimal values: USDG/1e6, option tokens/1e18, WAD values/1e18.

-- Remove the old product's Timescale policy jobs first. Each policy job starts as soon as it is added (0001, 0003), so
-- without this a refresh can run while the DROPs below delete the same aggregate ("tuple concurrently deleted", seen on
-- CI and on a fresh install that applies 0001..0008 in one go). delete_job waits for a running job to finish. The ticks
-- retention policy is added again at the end of this file. Servers without TimescaleDB have no jobs view, so skip.
DO $$
BEGIN
  IF to_regclass('timescaledb_information.jobs') IS NOT NULL THEN
    PERFORM delete_job(job_id) FROM timescaledb_information.jobs
      WHERE proc_name IN ('policy_refresh_continuous_aggregate', 'policy_retention');
  END IF;
END $$;
--> statement-breakpoint
DROP MATERIALIZED VIEW IF EXISTS candles_1m;
--> statement-breakpoint
DROP MATERIALIZED VIEW IF EXISTS candles_1h;
--> statement-breakpoint
DROP MATERIALIZED VIEW IF EXISTS candles_1d;
--> statement-breakpoint
DROP MATERIALIZED VIEW IF EXISTS market_carry_1d;
--> statement-breakpoint
DROP MATERIALIZED VIEW IF EXISTS vault_1h;
--> statement-breakpoint
DROP TABLE IF EXISTS ticks;
--> statement-breakpoint
DROP TABLE IF EXISTS vault_ticks;
--> statement-breakpoint
DROP TABLE IF EXISTS trades;
--> statement-breakpoint
DROP TABLE IF EXISTS transfers;
--> statement-breakpoint
DROP TABLE IF EXISTS vault_events;
--> statement-breakpoint
DROP TABLE IF EXISTS vault_account_state;
--> statement-breakpoint
DROP TABLE IF EXISTS hedges;
--> statement-breakpoint
DROP TABLE IF EXISTS regime_log;
--> statement-breakpoint
DROP TABLE IF EXISTS carry_updates;
--> statement-breakpoint
DROP TABLE IF EXISTS oracle_updates;
--> statement-breakpoint
DROP TABLE IF EXISTS markets;
--> statement-breakpoint
TRUNCATE TABLE balances;
--> statement-breakpoint
-- The indexer rebuilds everything from the new deployment's first block.
DELETE FROM cursors WHERE name = 'main';
--> statement-breakpoint

-- One row per listed series. norm/last_accrual follow the latest norm_history row; buyable/archived follow the latest
-- series_flag_log rows, so both can be recomputed after a reorg.
CREATE TABLE series (
  id text PRIMARY KEY,
  stock_token text NOT NULL,
  name text,
  feed text,
  is_call boolean NOT NULL,
  speed text NOT NULL CHECK (speed IN ('DAILY', 'WEEKLY')),
  tau_s integer NOT NULL,
  strike numeric(78, 18) NOT NULL,
  token text NOT NULL,
  norm numeric(78, 18) NOT NULL DEFAULT 1,
  last_accrual timestamptz NOT NULL,
  buyable boolean NOT NULL DEFAULT false,
  archived boolean NOT NULL DEFAULT false,
  listed_at timestamptz NOT NULL,
  listed_block bigint NOT NULL,
  listed_tx text NOT NULL,
  listed_log integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX series_token_uq ON series (token);
--> statement-breakpoint
CREATE INDEX series_stock_idx ON series (stock_token, is_call, speed, strike);
--> statement-breakpoint
CREATE INDEX series_name_idx ON series (name);
--> statement-breakpoint

CREATE TABLE series_flag_log (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  ts timestamptz NOT NULL,
  series_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('buyable', 'archived')),
  value boolean NOT NULL,
  PRIMARY KEY (tx_hash, log_index, kind)
);
--> statement-breakpoint
CREATE INDEX series_flag_log_series_idx ON series_flag_log (series_id, kind, block DESC, log_index DESC);
--> statement-breakpoint

-- Both sides of every trade. units are WAD option units, shares are option-token amounts (18 dp), usdg is 6 dp.
CREATE TABLE trades (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  ts timestamptz NOT NULL,
  series_id text NOT NULL,
  account text NOT NULL,
  recipient text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  units numeric(78, 18) NOT NULL,
  shares numeric(78, 18) NOT NULL,
  usdg numeric(78, 18) NOT NULL,
  v_mark numeric(78, 18) NOT NULL,
  sigma_bps integer NOT NULL,
  session text NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
--> statement-breakpoint
CREATE INDEX trades_account_ts_idx ON trades (account, ts DESC);
--> statement-breakpoint
CREATE INDEX trades_recipient_ts_idx ON trades (recipient, ts DESC);
--> statement-breakpoint
CREATE INDEX trades_series_ts_idx ON trades (series_id, ts DESC);
--> statement-breakpoint
CREATE INDEX trades_block_idx ON trades (block);
--> statement-breakpoint

CREATE TABLE shields (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  ts timestamptz NOT NULL,
  account text NOT NULL,
  stock_token text NOT NULL,
  series_id text NOT NULL,
  token_units numeric(78, 18) NOT NULL,
  usdg_paid numeric(78, 18) NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
--> statement-breakpoint
CREATE INDEX shields_account_ts_idx ON shields (account, ts DESC);
--> statement-breakpoint
CREATE INDEX shields_block_idx ON shields (block);
--> statement-breakpoint

CREATE TABLE agent_trades (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  ts timestamptz NOT NULL,
  owner text NOT NULL,
  agent text NOT NULL,
  series_id text NOT NULL,
  is_buy boolean NOT NULL,
  usdg numeric(78, 18) NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
--> statement-breakpoint
CREATE INDEX agent_trades_owner_ts_idx ON agent_trades (owner, ts DESC);
--> statement-breakpoint
CREATE INDEX agent_trades_block_idx ON agent_trades (block);
--> statement-breakpoint

-- Funding history: one row per Accrued event. Hypertable on ts.
CREATE TABLE norm_history (
  series_id text NOT NULL,
  ts timestamptz NOT NULL,
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  norm numeric(78, 18) NOT NULL,
  v_mark numeric(78, 18) NOT NULL,
  payoff numeric(78, 18) NOT NULL,
  session text NOT NULL,
  PRIMARY KEY (series_id, ts, tx_hash, log_index)
);
--> statement-breakpoint
CREATE INDEX norm_history_block_idx ON norm_history (block);
--> statement-breakpoint
SELECT create_hypertable('norm_history', 'ts', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
--> statement-breakpoint

-- Underlying price and vol inputs per Stock Token, one row per snapshot. Hypertable on ts.
CREATE TABLE ticks (
  stock_token text NOT NULL,
  name text,
  ts timestamptz NOT NULL,
  block bigint NOT NULL,
  spot numeric(78, 18) NOT NULL,
  session text NOT NULL,
  fresh boolean NOT NULL,
  buys_paused boolean NOT NULL DEFAULT false,
  price_updated_at timestamptz,
  sigma_daily_bps integer,
  sigma_weekly_bps integer,
  vol_stale boolean,
  PRIMARY KEY (stock_token, ts)
);
--> statement-breakpoint
CREATE INDEX ticks_block_idx ON ticks (block);
--> statement-breakpoint
SELECT create_hypertable('ticks', 'ts', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
--> statement-breakpoint
SELECT add_retention_policy('ticks', drop_after => INTERVAL '90 days');
--> statement-breakpoint

-- Every VolPosted event. sig and the earnings buy-block window come from the post() calldata when it can be read.
CREATE TABLE vol_posts (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  ts timestamptz NOT NULL,
  stock_token text NOT NULL,
  name text,
  speed text NOT NULL CHECK (speed IN ('DAILY', 'WEEKLY')),
  sigma_bps integer NOT NULL,
  skew_k numeric(78, 0) NOT NULL,
  event_bump_bps integer NOT NULL,
  buy_block_from timestamptz,
  buy_block_to timestamptz,
  valid_until timestamptz NOT NULL,
  nonce numeric(78, 0) NOT NULL,
  sig text,
  PRIMARY KEY (tx_hash, log_index)
);
--> statement-breakpoint
CREATE INDEX vol_posts_stock_ts_idx ON vol_posts (stock_token, speed, ts DESC);
--> statement-breakpoint
CREATE INDEX vol_posts_block_idx ON vol_posts (block);
--> statement-breakpoint

-- Pool NAV snapshots (on every trade, and at least every 10 minutes). Hypertable on ts.
CREATE TABLE pool_nav (
  ts timestamptz NOT NULL PRIMARY KEY,
  block bigint NOT NULL,
  usdg numeric(78, 18) NOT NULL,
  hedge_equity numeric(78, 18) NOT NULL,
  option_liability numeric(78, 18) NOT NULL,
  reserve numeric(78, 18) NOT NULL,
  nav numeric(78, 18) NOT NULL,
  nav_per_share numeric(78, 18) NOT NULL
);
--> statement-breakpoint
CREATE INDEX pool_nav_block_idx ON pool_nav (block);
--> statement-breakpoint
SELECT create_hypertable('pool_nav', 'ts', chunk_time_interval => INTERVAL '7 days', if_not_exists => TRUE);
--> statement-breakpoint

-- Per-name risk exposure from engine.netGreeks, one row per snapshot per name.
CREATE TABLE limits_state (
  name text NOT NULL,
  ts timestamptz NOT NULL,
  block bigint NOT NULL,
  stock_token text NOT NULL,
  net_delta numeric(78, 18) NOT NULL,
  net_gamma numeric(78, 18) NOT NULL,
  net_vega numeric(78, 18) NOT NULL,
  stress_loss_bps numeric(20, 4) NOT NULL,
  PRIMARY KEY (name, ts)
);
--> statement-breakpoint
CREATE INDEX limits_state_block_idx ON limits_state (block);
--> statement-breakpoint

-- Hedger fills (written by the hedger, not the indexer).
CREATE TABLE hedges (
  id bigserial PRIMARY KEY,
  venue text NOT NULL,
  name text NOT NULL,
  side text NOT NULL CHECK (side IN ('buy', 'sell')),
  qty numeric(78, 18) NOT NULL,
  px numeric(78, 18) NOT NULL,
  ts timestamptz NOT NULL,
  venue_ref text
);
--> statement-breakpoint
CREATE UNIQUE INDEX hedges_venue_ref_uq ON hedges (venue, venue_ref) WHERE venue_ref IS NOT NULL;
--> statement-breakpoint
CREATE INDEX hedges_name_ts_idx ON hedges (name, ts DESC);
--> statement-breakpoint

-- Sells escrowed while a name is HALTED, filled at the first fresh price.
CREATE TABLE queued_sells (
  ticket numeric(78, 0) PRIMARY KEY,
  series_id text NOT NULL,
  seller text NOT NULL,
  recipient text NOT NULL,
  tokens numeric(78, 18) NOT NULL,
  queued_at timestamptz NOT NULL,
  queued_block bigint NOT NULL,
  queued_tx text NOT NULL,
  queued_log integer NOT NULL,
  status text NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'filled', 'cancelled')),
  closed_at timestamptz,
  closed_block bigint,
  closed_tx text,
  closed_log integer,
  filler text,
  usdg_out numeric(78, 18)
);
--> statement-breakpoint
CREATE INDEX queued_sells_seller_idx ON queued_sells (seller, queued_at DESC);
--> statement-breakpoint
CREATE INDEX queued_sells_open_idx ON queued_sells (series_id) WHERE status = 'open';
--> statement-breakpoint
CREATE INDEX queued_sells_block_idx ON queued_sells (queued_block);
--> statement-breakpoint

-- Pool withdrawal tickets (72h queue).
CREATE TABLE withdrawals (
  owner text NOT NULL,
  ticket numeric(78, 0) NOT NULL,
  shares numeric(78, 18) NOT NULL,
  claimable_at timestamptz NOT NULL,
  queued_at timestamptz NOT NULL,
  queued_block bigint NOT NULL,
  queued_tx text NOT NULL,
  queued_log integer NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'claimed')),
  claimed_at timestamptz,
  claimed_block bigint,
  claimed_tx text,
  claimed_log integer,
  usdg numeric(78, 18),
  PRIMARY KEY (owner, ticket)
);
--> statement-breakpoint
CREATE INDEX withdrawals_status_idx ON withdrawals (status, claimable_at);
--> statement-breakpoint
CREATE INDEX withdrawals_block_idx ON withdrawals (queued_block);
--> statement-breakpoint

-- Pool deposits and withdrawals (ERC-4626 Deposit / Withdraw).
CREATE TABLE pool_events (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  ts timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('deposit', 'withdraw')),
  account text NOT NULL,
  sender text,
  receiver text,
  assets numeric(78, 18) NOT NULL,
  shares numeric(78, 18) NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
--> statement-breakpoint
CREATE INDEX pool_events_account_ts_idx ON pool_events (account, ts DESC);
--> statement-breakpoint
CREATE INDEX pool_events_block_idx ON pool_events (block);
--> statement-breakpoint

CREATE TABLE hedge_equity_posts (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  ts timestamptz NOT NULL,
  equity_usdg numeric(78, 18) NOT NULL,
  as_of timestamptz NOT NULL,
  ref text NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
--> statement-breakpoint
CREATE INDEX hedge_equity_posts_ts_idx ON hedge_equity_posts (ts DESC);
--> statement-breakpoint
CREATE INDEX hedge_equity_posts_block_idx ON hedge_equity_posts (block);
--> statement-breakpoint

-- Engine BuysPaused (global or per series) and PriceGuard BuysPausedSet (per stock).
CREATE TABLE pause_log (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  ts timestamptz NOT NULL,
  scope text NOT NULL CHECK (scope IN ('global', 'series', 'stock')),
  key text NOT NULL,
  paused boolean NOT NULL,
  reason text,
  PRIMARY KEY (tx_hash, log_index)
);
--> statement-breakpoint
CREATE INDEX pause_log_scope_idx ON pause_log (scope, key, block DESC, log_index DESC);
--> statement-breakpoint
CREATE INDEX pause_log_block_idx ON pause_log (block);
--> statement-breakpoint

-- Option-token and pool-share transfers, including mints and burns (from or to the zero address).
CREATE TABLE transfers (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  ts timestamptz NOT NULL,
  series_id text,
  token text NOT NULL,
  from_addr text NOT NULL,
  to_addr text NOT NULL,
  amount numeric(78, 18) NOT NULL,
  PRIMARY KEY (tx_hash, log_index)
);
--> statement-breakpoint
CREATE INDEX transfers_from_ts_idx ON transfers (from_addr, ts DESC);
--> statement-breakpoint
CREATE INDEX transfers_to_ts_idx ON transfers (to_addr, ts DESC);
--> statement-breakpoint
CREATE INDEX transfers_token_from_idx ON transfers (token, from_addr);
--> statement-breakpoint
CREATE INDEX transfers_token_to_idx ON transfers (token, to_addr);
--> statement-breakpoint
CREATE INDEX transfers_block_idx ON transfers (block);
--> statement-breakpoint

-- Hourly Merkle roots over trades, vol posts and NAV snapshots (written by the receipts keeper job).
CREATE TABLE receipts (
  period_start timestamptz PRIMARY KEY,
  period_end timestamptz NOT NULL,
  root text NOT NULL,
  leaf_count integer NOT NULL,
  trades_count integer NOT NULL DEFAULT 0,
  vol_posts_count integer NOT NULL DEFAULT 0,
  nav_count integer NOT NULL DEFAULT 0,
  tx_hash text,
  block bigint,
  created_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint

-- Hashes of the most recent blocks the indexer has ingested, used to detect reorgs.
CREATE TABLE block_hashes (
  block bigint PRIMARY KEY,
  hash text NOT NULL,
  parent_hash text NOT NULL,
  ts timestamptz NOT NULL
);
