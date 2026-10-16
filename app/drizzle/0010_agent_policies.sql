-- AgentRouter policy lifecycle (PolicySet, PolicyRevoked), one row per event. The current policy of an
-- (owner, agent) pair is its newest row, so a reorg only has to delete rows above the ancestor block.
CREATE TABLE agent_policy_events (
  tx_hash text NOT NULL,
  log_index integer NOT NULL,
  block bigint NOT NULL,
  ts timestamptz NOT NULL,
  kind text NOT NULL CHECK (kind IN ('set', 'revoked')),
  owner text NOT NULL,
  agent text NOT NULL,
  budget_usdg numeric(78, 18),
  max_per_trade_usdg numeric(78, 18),
  expires_at timestamptz,
  can_sell boolean,
  can_shield boolean,
  CONSTRAINT agent_policy_events_pk PRIMARY KEY (tx_hash, log_index)
);
--> statement-breakpoint
CREATE INDEX agent_policy_events_owner_idx ON agent_policy_events (owner, agent, block DESC, log_index DESC);
--> statement-breakpoint
CREATE INDEX agent_policy_events_block_idx ON agent_policy_events (block);
--> statement-breakpoint
CREATE INDEX agent_trades_owner_agent_idx ON agent_trades (owner, agent, ts DESC);
