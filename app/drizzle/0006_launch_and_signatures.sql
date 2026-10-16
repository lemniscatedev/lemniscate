CREATE TABLE market_launch (
  symbol text PRIMARY KEY,
  launched boolean NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  note text
);
--> statement-breakpoint
CREATE TABLE upcoming_subscriptions (
  upcoming_id text NOT NULL,
  address text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (upcoming_id, address)
);
--> statement-breakpoint
CREATE INDEX upcoming_subscriptions_address_idx ON upcoming_subscriptions (address);
--> statement-breakpoint
CREATE TABLE api_nonces (
  address text NOT NULL,
  nonce text NOT NULL,
  action text NOT NULL,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (address, nonce)
);
--> statement-breakpoint
CREATE INDEX api_nonces_expires_idx ON api_nonces (expires_at);
