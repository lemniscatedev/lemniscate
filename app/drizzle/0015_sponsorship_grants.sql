-- F25/F31: every gas sponsorship the API signs is booked here first, so per-account, per-owner, per-network and global
-- daily quotas are enforced in the database (survive restarts, shared by every API instance). A grant whose operation
-- could not be built is deleted again. `day` is the UTC day, like the paymaster's own daily caps.
CREATE TABLE sponsorship_grants (
  id bigserial PRIMARY KEY,
  day date NOT NULL DEFAULT ((now() AT TIME ZONE 'utc')::date),
  grp text NOT NULL,
  kind text NOT NULL,
  account text NOT NULL,
  owner text,
  ip_key text NOT NULL,
  notional_usdg numeric(38, 6) NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sponsorship_grants_grp_ck CHECK (grp IN ('entry', 'exit'))
);
--> statement-breakpoint
CREATE INDEX sponsorship_grants_day_grp_idx ON sponsorship_grants (day, grp);
--> statement-breakpoint
CREATE INDEX sponsorship_grants_day_account_idx ON sponsorship_grants (day, account);
--> statement-breakpoint
CREATE INDEX sponsorship_grants_day_owner_idx ON sponsorship_grants (day, owner);
--> statement-breakpoint
CREATE INDEX sponsorship_grants_day_ip_idx ON sponsorship_grants (day, ip_key);
