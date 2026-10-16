CREATE TABLE invite_codes (
  code_hash text PRIMARY KEY,
  label text,
  max_uses integer NOT NULL DEFAULT 1,
  uses integer NOT NULL DEFAULT 0,
  revoked boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invite_codes_uses_ck CHECK (uses >= 0 AND max_uses >= 1)
);
--> statement-breakpoint
CREATE TABLE invite_redemptions (
  address text PRIMARY KEY,
  code_hash text NOT NULL,
  redeemed_at timestamptz NOT NULL DEFAULT now()
);
--> statement-breakpoint
CREATE INDEX invite_redemptions_code_idx ON invite_redemptions (code_hash);
--> statement-breakpoint
CREATE TABLE app_settings (
  key text PRIMARY KEY,
  value text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);
