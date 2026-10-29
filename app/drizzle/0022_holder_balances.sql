-- $LMNS holder perks (2026-10-29): the API never reads the chain (R9), so the keeper's "holders" job reads the $LMNS balance
-- of every wallet that asked for its holder level within the last day, and the API reads the result from here.
CREATE TABLE holder_watch (
  address text PRIMARY KEY,
  requested_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE TABLE holder_balances (
  address text PRIMARY KEY,
  token text NOT NULL,
  balance numeric(78, 0) NOT NULL,
  block_number bigint NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX holder_watch_requested_idx ON holder_watch (requested_at);
