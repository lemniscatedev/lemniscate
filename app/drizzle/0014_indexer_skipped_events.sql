-- F04: an event the indexer could not apply is rolled back alone and recorded here, so one malformed event never halts ingestion.
CREATE TABLE indexer_skipped_events (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  source text NOT NULL,
  event_name text NOT NULL,
  reason text NOT NULL,
  skipped_at timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tx_hash, log_index)
);
--> statement-breakpoint
CREATE INDEX indexer_skipped_events_block_idx ON indexer_skipped_events (block);
