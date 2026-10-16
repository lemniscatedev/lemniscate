CREATE EXTENSION IF NOT EXISTS timescaledb;
--> statement-breakpoint
SELECT create_hypertable('ticks', 'ts', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
--> statement-breakpoint
SELECT create_hypertable('vault_ticks', 'ts', chunk_time_interval => INTERVAL '1 day', if_not_exists => TRUE);
--> statement-breakpoint
CREATE MATERIALIZED VIEW candles_1m
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 minute', ts) AS bucket,
  market_id,
  first(price, ts) AS open_price,
  max(price) AS high_price,
  min(price) AS low_price,
  last(price, ts) AS close_price,
  first("index", ts) AS open_index,
  max("index") AS high_index,
  min("index") AS low_index,
  last("index", ts) AS close_index
FROM ticks
GROUP BY bucket, market_id
WITH NO DATA;
--> statement-breakpoint
CREATE MATERIALIZED VIEW candles_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', ts) AS bucket,
  market_id,
  first(price, ts) AS open_price,
  max(price) AS high_price,
  min(price) AS low_price,
  last(price, ts) AS close_price,
  first("index", ts) AS open_index,
  max("index") AS high_index,
  min("index") AS low_index,
  last("index", ts) AS close_index
FROM ticks
GROUP BY bucket, market_id
WITH NO DATA;
--> statement-breakpoint
CREATE MATERIALIZED VIEW candles_1d
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 day', ts) AS bucket,
  market_id,
  first(price, ts) AS open_price,
  max(price) AS high_price,
  min(price) AS low_price,
  last(price, ts) AS close_price,
  first("index", ts) AS open_index,
  max("index") AS high_index,
  min("index") AS low_index,
  last("index", ts) AS close_index
FROM ticks
GROUP BY bucket, market_id
WITH NO DATA;
--> statement-breakpoint
CREATE MATERIALIZED VIEW vault_1h
WITH (timescaledb.continuous) AS
SELECT
  time_bucket(INTERVAL '1 hour', ts) AS bucket,
  first(nav, ts) AS open_nav,
  max(nav) AS high_nav,
  min(nav) AS low_nav,
  last(nav, ts) AS close_nav,
  first(nav_per_share, ts) AS open_nav_per_share,
  last(nav_per_share, ts) AS close_nav_per_share
FROM vault_ticks
GROUP BY bucket
WITH NO DATA;
--> statement-breakpoint
SELECT add_continuous_aggregate_policy(
  'candles_1m',
  start_offset => INTERVAL '2 days',
  end_offset => INTERVAL '2 minutes',
  schedule_interval => INTERVAL '1 minute'
);
--> statement-breakpoint
SELECT add_continuous_aggregate_policy(
  'candles_1h',
  start_offset => INTERVAL '30 days',
  end_offset => INTERVAL '2 hours',
  schedule_interval => INTERVAL '10 minutes'
);
--> statement-breakpoint
SELECT add_continuous_aggregate_policy(
  'candles_1d',
  start_offset => INTERVAL '30 days',
  end_offset => INTERVAL '2 days',
  schedule_interval => INTERVAL '1 hour'
);
--> statement-breakpoint
SELECT add_continuous_aggregate_policy(
  'vault_1h',
  start_offset => INTERVAL '30 days',
  end_offset => INTERVAL '2 hours',
  schedule_interval => INTERVAL '10 minutes'
);
--> statement-breakpoint
SELECT add_retention_policy('ticks', drop_after => INTERVAL '30 days');
