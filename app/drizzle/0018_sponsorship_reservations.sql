-- R11: a sponsorship booking is a reservation. It used to count for the whole UTC day from the moment the API signed the
-- paymaster data, whether or not the operation was ever submitted, so signatures nobody used (one per fresh Kernel address,
-- no funds at risk) could use up the global exit budget for everyone. Now a row stops counting when the signature can no
-- longer be used (expires_at), unless /v1/userop/send relayed the operation (submitted_at). The global budget counts only
-- relayed operations; the per-account, per-owner and per-network limits count relayed ones and live reservations.
ALTER TABLE sponsorship_grants ADD COLUMN expires_at timestamptz NOT NULL DEFAULT now() + interval '6 minutes';
--> statement-breakpoint
ALTER TABLE sponsorship_grants ADD COLUMN user_op_hash text;
--> statement-breakpoint
ALTER TABLE sponsorship_grants ADD COLUMN submitted_at timestamptz;
--> statement-breakpoint
CREATE INDEX sponsorship_grants_user_op_idx ON sponsorship_grants (user_op_hash);
