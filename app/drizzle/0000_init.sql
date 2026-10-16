CREATE TABLE "account_metadata" (
	"address" text PRIMARY KEY NOT NULL,
	"first_seen_block" bigint NOT NULL,
	"first_seen_at" timestamp with time zone NOT NULL,
	"last_seen_block" bigint NOT NULL,
	"last_activity_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "balances" (
	"token" text NOT NULL,
	"account" text NOT NULL,
	"balance" numeric(78, 18) NOT NULL,
	"updated_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "balances_pk" PRIMARY KEY("token","account")
);
--> statement-breakpoint
CREATE TABLE "carry_updates" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"market_id" smallint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"base_carry_wad" numeric(78, 18) NOT NULL,
	CONSTRAINT "carry_updates_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "corp_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"process_date" date,
	"effective_at" timestamp with time zone,
	"old_mult" numeric(78, 18),
	"new_mult" numeric(78, 18),
	"details" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source" text NOT NULL,
	"verified_continuity" boolean,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cursors" (
	"name" text PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hedges" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"market_id" smallint NOT NULL,
	"is_buy" boolean NOT NULL,
	"amount_in" numeric(78, 18) NOT NULL,
	"amount_out" numeric(78, 18) NOT NULL,
	"hedge_units_after" numeric(78, 18) NOT NULL,
	CONSTRAINT "hedges_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "keeper_status" (
	"job" text PRIMARY KEY NOT NULL,
	"last_run" timestamp with time zone,
	"last_ok" timestamp with time zone,
	"last_error" text,
	"last_tx" text,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "markets" (
	"id" smallint PRIMARY KEY NOT NULL,
	"symbol" text NOT NULL,
	"token" text NOT NULL,
	"stock" text NOT NULL,
	"feed" text NOT NULL,
	"scale" numeric(78, 0) NOT NULL,
	"pool_fee" integer NOT NULL,
	"listed_block" bigint NOT NULL,
	"config" jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "oracle_updates" (
	"market_id" smallint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"round_id" numeric(78, 0) NOT NULL,
	"answer" numeric(78, 18) NOT NULL,
	"block" bigint NOT NULL,
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	CONSTRAINT "oracle_updates_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "regime_log" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"market_id" smallint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"from_regime" smallint NOT NULL,
	"to_regime" smallint NOT NULL,
	"block" bigint NOT NULL,
	CONSTRAINT "regime_log_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "ticks" (
	"market_id" smallint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"block" bigint NOT NULL,
	"spot" numeric(78, 18) NOT NULL,
	"index" numeric(78, 18) NOT NULL,
	"norm_factor" numeric(78, 18) NOT NULL,
	"price" numeric(78, 18) NOT NULL,
	"bid" numeric(78, 18) NOT NULL,
	"ask" numeric(78, 18) NOT NULL,
	"carry_wad" numeric(78, 18) NOT NULL,
	"regime" smallint NOT NULL,
	"vault_short" numeric(78, 18) NOT NULL,
	"liability" numeric(78, 18) NOT NULL,
	"hedge_units" numeric(78, 18) NOT NULL,
	"oracle_updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ticks_pk" PRIMARY KEY("market_id","ts")
);
--> statement-breakpoint
CREATE TABLE "trades" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"market_id" smallint NOT NULL,
	"account" text NOT NULL,
	"recipient" text NOT NULL,
	"side" text NOT NULL,
	"usdg" numeric(78, 18) NOT NULL,
	"fee" numeric(78, 18) NOT NULL,
	"tokens" numeric(78, 18) NOT NULL,
	"price" numeric(78, 18) NOT NULL,
	"index" numeric(78, 18) NOT NULL,
	"norm_factor" numeric(78, 18) NOT NULL,
	CONSTRAINT "trades_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "transfers" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"market_id" smallint,
	"token" text NOT NULL,
	"from_addr" text NOT NULL,
	"to_addr" text NOT NULL,
	"amount" numeric(78, 18) NOT NULL,
	CONSTRAINT "transfers_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "vault_account_state" (
	"account" text PRIMARY KEY NOT NULL,
	"is_depositor" boolean NOT NULL,
	"unlock_time" timestamp with time zone,
	"updated_block" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "vault_events" (
	"tx_hash" text NOT NULL,
	"log_index" integer NOT NULL,
	"block" bigint NOT NULL,
	"ts" timestamp with time zone NOT NULL,
	"kind" text NOT NULL,
	"account" text NOT NULL,
	"sender" text,
	"receiver" text,
	"assets" numeric(78, 18) NOT NULL,
	"shares" numeric(78, 18) NOT NULL,
	CONSTRAINT "vault_events_pk" PRIMARY KEY("tx_hash","log_index")
);
--> statement-breakpoint
CREATE TABLE "vault_ticks" (
	"ts" timestamp with time zone PRIMARY KEY NOT NULL,
	"block" bigint NOT NULL,
	"nav" numeric(78, 18) NOT NULL,
	"total_assets" numeric(78, 18) NOT NULL,
	"total_supply" numeric(78, 18) NOT NULL,
	"nav_per_share" numeric(78, 18) NOT NULL,
	"usdg" numeric(78, 18) NOT NULL,
	"total_liability" numeric(78, 18) NOT NULL,
	"max_global_exposure_bps" integer NOT NULL,
	"public_deposits" boolean NOT NULL,
	"deposit_cap_remaining" numeric(78, 18) NOT NULL
);
--> statement-breakpoint
CREATE INDEX "balances_account_idx" ON "balances" USING btree ("account");--> statement-breakpoint
CREATE INDEX "carry_updates_market_ts_idx" ON "carry_updates" USING btree ("market_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "corp_actions_symbol_effective_idx" ON "corp_actions" USING btree ("symbol","effective_at");--> statement-breakpoint
CREATE INDEX "hedges_market_ts_idx" ON "hedges" USING btree ("market_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX "markets_symbol_uq" ON "markets" USING btree ("symbol");--> statement-breakpoint
CREATE INDEX "oracle_updates_market_ts_idx" ON "oracle_updates" USING btree ("market_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "regime_log_market_ts_idx" ON "regime_log" USING btree ("market_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "ticks_market_ts_idx" ON "ticks" USING btree ("market_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trades_account_ts_idx" ON "trades" USING btree ("account","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trades_market_ts_idx" ON "trades" USING btree ("market_id","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "trades_recipient_ts_idx" ON "trades" USING btree ("recipient","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transfers_from_ts_idx" ON "transfers" USING btree ("from_addr","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transfers_to_ts_idx" ON "transfers" USING btree ("to_addr","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "transfers_token_account_idx" ON "transfers" USING btree ("token","to_addr");--> statement-breakpoint
CREATE INDEX "vault_events_account_ts_idx" ON "vault_events" USING btree ("account","ts" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "vault_events_kind_ts_idx" ON "vault_events" USING btree ("kind","ts" DESC NULLS LAST);
