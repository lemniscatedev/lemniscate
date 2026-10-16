CREATE TABLE IF NOT EXISTS token_flow (
  stock text NOT NULL,
  flow_date date NOT NULL,
  symbol text NOT NULL,
  mint_burn_usd numeric(78,18) NOT NULL,
  first_seen_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (stock, flow_date)
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS token_flow_date_idx ON token_flow (flow_date DESC);
