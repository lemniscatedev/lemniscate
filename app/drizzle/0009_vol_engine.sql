-- vol-engine bookkeeping. Intent rows are what the engine signed (and whether it was sent); vol_posts stays the
-- indexer's table of on-chain VolPosted events. Alerts record earnings-source disagreements and failed sends.
CREATE TABLE vol_post_intents (
  id bigserial PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now(),
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
  digest text NOT NULL,
  sig text NOT NULL,
  status text NOT NULL CHECK (status IN ('dry_run', 'pending', 'sent', 'failed')),
  tx_hash text,
  flags jsonb NOT NULL DEFAULT '[]'::jsonb
);
--> statement-breakpoint
CREATE UNIQUE INDEX vol_post_intents_nonce_uq ON vol_post_intents (stock_token, speed, nonce);
--> statement-breakpoint
CREATE INDEX vol_post_intents_stock_idx ON vol_post_intents (stock_token, speed, created_at DESC);
--> statement-breakpoint
CREATE TABLE vol_alerts (
  id bigserial PRIMARY KEY,
  ts timestamptz NOT NULL DEFAULT now(),
  name text NOT NULL,
  kind text NOT NULL,
  detail jsonb NOT NULL DEFAULT '{}'::jsonb
);
--> statement-breakpoint
CREATE INDEX vol_alerts_name_kind_idx ON vol_alerts (name, kind, ts DESC);
