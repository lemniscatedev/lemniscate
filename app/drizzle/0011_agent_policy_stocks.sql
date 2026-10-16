-- AgentRouter PolicyStocks (the names a policy allows, one row per setPolicy) and QueuedSellFor (which owner a
-- router-held sell ticket belongs to). Both are one row per event, so a reorg deletes rows above the ancestor block.
CREATE TABLE agent_policy_stocks (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  ts timestamptz NOT NULL,
  owner text NOT NULL,
  agent text NOT NULL,
  stocks text[] NOT NULL,
  CONSTRAINT agent_policy_stocks_pk PRIMARY KEY (tx_hash, log_index)
);
--> statement-breakpoint
CREATE INDEX agent_policy_stocks_owner_idx ON agent_policy_stocks (owner, agent, block DESC, log_index DESC);
--> statement-breakpoint
CREATE INDEX agent_policy_stocks_block_idx ON agent_policy_stocks (block);
--> statement-breakpoint
CREATE TABLE router_tickets (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  ts timestamptz NOT NULL,
  ticket numeric(78, 0) NOT NULL,
  owner text NOT NULL,
  agent text NOT NULL,
  series_id text NOT NULL,
  CONSTRAINT router_tickets_pk PRIMARY KEY (tx_hash, log_index),
  CONSTRAINT router_tickets_ticket_uq UNIQUE (ticket)
);
--> statement-breakpoint
CREATE INDEX router_tickets_owner_idx ON router_tickets (owner, block DESC);
--> statement-breakpoint
CREATE INDEX router_tickets_block_idx ON router_tickets (block);
