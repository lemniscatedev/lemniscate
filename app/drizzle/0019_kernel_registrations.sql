-- R17 (decision 62): a standard Kernel account that someone deployed through the public factory (not in a sponsored
-- operation) is unknown to the paymaster. LemniscatePaymaster.registerKernelAccount lets anyone register it; the API holds no
-- funded key, so it queues the account here and the keeper sends the registration.
CREATE TABLE kernel_registrations (
  account text PRIMARY KEY,
  owner text NOT NULL,
  init_data text NOT NULL,
  salt text NOT NULL,
  requested_at timestamptz NOT NULL DEFAULT now(),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  done_at timestamptz,
  tx_hash text,
  last_error text
);
--> statement-breakpoint
CREATE INDEX kernel_registrations_pending_idx ON kernel_registrations (next_attempt_at) WHERE done_at IS NULL;
