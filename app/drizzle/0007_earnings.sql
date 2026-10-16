CREATE TABLE earnings (
  symbol text NOT NULL,
  report_date date NOT NULL,
  session text NOT NULL DEFAULT 'unknown' CHECK (session IN ('pre','post','unknown')),
  fiscal_date_ending date,
  source text NOT NULL,
  fetched_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (symbol, report_date, source)
);
--> statement-breakpoint
CREATE INDEX earnings_date_idx ON earnings (report_date);
