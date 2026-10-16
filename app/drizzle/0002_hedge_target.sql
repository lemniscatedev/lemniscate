ALTER TABLE ticks ADD COLUMN hedge_target numeric(78, 18) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE ticks ADD COLUMN buys_paused boolean NOT NULL DEFAULT false;
