-- R3-05 (decision 72): the API counts every operation it signs for, from the moment it signs, whoever later bundles it (its own
-- relay, a public bundler, or a direct EntryPoint.handleOps). R11's relay-time count let self-bundled operations spend the
-- paymaster's single on-chain cap unseen. A grant is now one EntryPoint nonce of one account: only one operation can ever
-- execute at a nonce, so rebuilding the same operation, from any client, reuses the grant instead of booking another one.
ALTER TABLE sponsorship_grants ADD COLUMN nonce text;
--> statement-breakpoint
CREATE INDEX sponsorship_grants_day_account_nonce_idx ON sponsorship_grants (day, account, nonce);
