-- Review F07/F08/F12/F15/F21/F24 follow-up (decisions 31, 32, 36): engine events the services show to users. Kinds:
-- series_retired (engine.retireDust), stock_settled (ORC-4 settleHalted, price = settlement S), halt_latched
-- (PriceGuard poke latched a halt) and hold_carried (an option-token transfer handed the sender's open sell hold to
-- the receiver, price = the sender's buy-time S when known).
CREATE TABLE engine_events (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  ts timestamptz NOT NULL,
  kind text NOT NULL,
  series_id text,
  stock_token text,
  account text,
  price numeric(78, 18),
  until timestamptz,
  PRIMARY KEY (tx_hash, log_index),
  CONSTRAINT engine_events_kind_ck CHECK (kind IN ('series_retired', 'stock_settled', 'halt_latched', 'hold_carried'))
);
--> statement-breakpoint
CREATE INDEX engine_events_block_idx ON engine_events (block);
--> statement-breakpoint
CREATE INDEX engine_events_account_ts_idx ON engine_events (account, ts DESC);
--> statement-breakpoint
CREATE INDEX engine_events_series_idx ON engine_events (series_id);
--> statement-breakpoint
CREATE INDEX engine_events_stock_idx ON engine_events (stock_token);
--> statement-breakpoint
-- The LP-flow liability bounds (engine.navLiability, decision 36) and the engine's trade guards at each snapshot.
ALTER TABLE pool_nav ADD COLUMN nav_liability_low numeric(78, 18);
--> statement-breakpoint
ALTER TABLE pool_nav ADD COLUMN nav_liability_high numeric(78, 18);
--> statement-breakpoint
ALTER TABLE pool_nav ADD COLUMN hold_seconds integer;
--> statement-breakpoint
ALTER TABLE pool_nav ADD COLUMN halt_settle_delay_seconds integer;
