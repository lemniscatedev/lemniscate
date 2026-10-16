CREATE MATERIALIZED VIEW market_carry_1d
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 day', ts) AS bucket,
  market_id,
  last(carry_wad, ts) AS carry_wad,
  last(regime, ts) AS regime
FROM ticks
GROUP BY bucket, market_id
WITH NO DATA;
--> statement-breakpoint
SELECT add_continuous_aggregate_policy(
  'market_carry_1d',
  start_offset => INTERVAL '28 days',
  end_offset => INTERVAL '2 days',
  schedule_interval => INTERVAL '1 hour'
);
