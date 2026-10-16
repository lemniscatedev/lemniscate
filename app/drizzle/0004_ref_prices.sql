CREATE TABLE IF NOT EXISTS ref_prices (
  stock text PRIMARY KEY,
  symbol text NOT NULL,
  bid numeric(78,18),
  ask numeric(78,18),
  token_bid numeric(78,18),
  token_ask numeric(78,18),
  daily_high numeric(78,18),
  daily_low numeric(78,18),
  daily_volume numeric(78,18),
  mint_burn_usd numeric(78,18),
  halt boolean NOT NULL DEFAULT false,
  generated_at timestamptz NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS ref_prices_symbol_idx ON ref_prices (symbol);
