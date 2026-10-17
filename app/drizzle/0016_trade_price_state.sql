-- Decision 30/31 (review F01/F02/F07/F10/F21-F23): the API prices trades at the worse of the feed S and
-- PriceGuard.tradeTwap, and a sell inside the account's hold at the worse of that and the buy-time S. The indexer's
-- snapshot stores the trade TWAP, the ORC-4 settlement price and the halt latch per stock, and the open holds
-- (engine.holdOf) of accounts that bought or received a series recently. The API never reads the chain.
ALTER TABLE ticks ADD COLUMN trade_twap numeric(78, 18);
--> statement-breakpoint
ALTER TABLE ticks ADD COLUMN settle_price numeric(78, 18);
--> statement-breakpoint
ALTER TABLE ticks ADD COLUMN halted_since timestamptz;
--> statement-breakpoint
CREATE TABLE holds (
  series_id text NOT NULL,
  account text NOT NULL,
  until timestamptz NOT NULL,
  s numeric(78, 18) NOT NULL,
  block bigint NOT NULL,
  PRIMARY KEY (series_id, account)
);
--> statement-breakpoint
CREATE INDEX holds_block_idx ON holds (block);
