-- On-chain truth for the pool's spot hedges (decision 19): one row per Rebalanced, CashRaised or HedgeUnitsSynced log.
-- stock_amount is Stock Token units, usdg_amount is USDG; both are null where the event does not carry them.
CREATE TABLE pool_hedge_events (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  ts timestamptz NOT NULL,
  kind text NOT NULL,
  stock text NOT NULL,
  side text,
  stock_amount numeric(78, 18),
  usdg_amount numeric(78, 18),
  units_after numeric(78, 18),
  PRIMARY KEY (tx_hash, log_index),
  CONSTRAINT pool_hedge_events_kind_ck CHECK (kind IN ('rebalance', 'cash_raised', 'units_synced'))
);
--> statement-breakpoint
CREATE INDEX pool_hedge_events_stock_ts_idx ON pool_hedge_events (stock, ts DESC);
--> statement-breakpoint
CREATE INDEX pool_hedge_events_block_idx ON pool_hedge_events (block);
