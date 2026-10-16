# vol-engine

Computes annualised volatility (sigma) per name and speed, signs it as EIP-712 typed data and posts it to `VolOracle`.
Launch names: NVDA, TSLA, SPY, QQQ, AAPL. Python 3.11+, numpy, eth-account, psycopg.

```bash
cd vol-engine
python3 -m venv .venv && . .venv/bin/activate
pip install -e '.[dev]'
pytest -q
```

## What it does

| Step | Rule | Module |
| --- | --- | --- |
| Realized vol | EWMA of 5-minute regular-hours log returns (half-life 1 day Daily, 5 days Weekly) plus a separate overnight close-to-open variance term, annualised over 252 days. Extended-hours prints are dropped and flagged | `bars.py`, `ewma.py`, `realized.py` |
| Base and floor | `max(sigma_RV * 1.15, floor)`; floors 30% (NVDA, TSLA, SPY, QQQ, AAPL) and 45% (other names) | `surface.py` |
| Skew | `sigma(K) = base * (1 + 1.2*max(0,-ln(K/S)) + 0.4*max(0, ln(K/S)))`. The coefficients ride in `skewK` as `(round(k_put*1e4) << 32) \| round(k_call*1e4)`; the engine applies them per strike | `surface.py` |
| Earnings | If a confirmed report is within 2 tau: `sigma_eff^2 = sigma^2 + E^2/tau`, E = median absolute 1-day move over the last 8 reports. Buy block `report - 60 min` to `report + 30 min`; Daily speed blocks the whole report day (New York time) | `earnings.py`, `engine.py` |
| Weekend | When the latest session is CLOSED: `sigma_eff^2 = sigma^2 + G^2/tau`, G = 90th percentile of absolute Friday close to Monday open moves | `surface.py` |
| Step guard | Never posts outside +-25% of the last post (the contract's rule, mirrored). A larger target is reached in steps and the post is flagged `ramped:target->posted` | `guard.py` |
| Signing | EIP-712 `Post`, domain `LemniscateVolOracle` v1. Reproduces `contracts/test/vectors/volpost-eip712.json` byte for byte | `signer.py` |

`sigmaBps` is the at-the-money sigma including the earnings and weekend bumps. `eventBumpBps` is the part of it those bumps added.

## Earnings sources (two, independent, free)

1. **alphavantage**: the daily calendar the keeper `earnings` job already imports.
2. **company_ir**: report dates the company published on its own investor-relations page, kept in
   `app/src/config/earnings-overrides.json` (confirmed entries only) and synced into the `earnings` table by the keeper.

A date is used only when both sources agree within one day. If they disagree by more than a day, or a source has no date,
and the report could fall inside the next 16 days, the post carries `buyBlockFrom = now`, `buyBlockTo = now + 24h` and an
`earnings_*` row goes to `vol_alerts`. Farther out the alert is written but buys are not blocked. The engine never invents a date.

## History the tables are too short for

`ticks` keeps 90 days, so the 26 weeks of weekend gaps and 8 past earnings moves do not exist in the database yet.
Until they do, conservative defaults apply and the post is flagged `weekend_move_default` / `earnings_move_default`.
Seed real history with JSON files (oldest first):

* `VOL_MOVES_FILE`: `{"NVDA": [0.051, -0.07, ...]}` 1-day moves after past reports
* `VOL_WEEKEND_FILE`: `{"NVDA": [0.012, ...]}` absolute Friday-close to Monday-open moves

`bun run seed-vol-history` (in `app/`) builds both from free public data (Yahoo daily bars, SEC EDGAR Item 2.02 filings for the
release times) into `app/config/vol-weekend.json` and `app/config/vol-moves.json`; see the header of `app/scripts/seed-vol-history.ts`.

Chainlink feeds publish on a 0.5% deviation or a 24-hour heartbeat, so 5-minute bars built from `ticks` are forward-filled
and understate realized vol on quiet names. The floors and the 1.15 markup cover that; tune them against the replay.

## Running

```bash
export DATABASE_URL=postgres://...            # reads ticks, earnings, vol_posts; writes vol_post_intents and vol_alerts
export VOL_SIGNER_KEYSTORE=/path/vol-signer.json VOL_SIGNER_KEYSTORE_PASSWORD_FILE=/path/vol-signer.password   # encrypted keystore (what production uses)
# export VOL_SIGNER_KEY=...                    # raw key: local development only, refused when NODE_ENV=production; never logged
export VOL_ORACLE_ADDRESS=0x... VOL_CHAIN_ID=4663
# Stock Token addresses are read from ticks (name -> stock_token); override with VOL_STOCKS=NVDA=0x...,TSLA=0x...
vol-engine post --once                         # one pass, signs and records intents, sends nothing
vol-engine post --loop --interval 300          # repeat; posts only on a real change or when the last post nears expiry
```

**Sending is off.** Nothing is submitted unless `VOL_SEND=1` (exactly `1`) and `VOL_RPC_URL` plus a gas key
(`VOL_SENDER_KEY`, defaulting to the signer key) are set. Without it every post is recorded with status `dry_run`.
The reader connection is read-only at the server level. Logs pass through a scrubber that removes configured keys
(any case, with or without `0x`), `key=` / `secret=` / `password=` assignments and URL passwords.

Intent rows live in `vol_post_intents` (migration `0009_vol_engine.sql`), not in `vol_posts`, which stays the indexer's table
of on-chain `VolPosted` events.

## Tests

`pytest -q` runs unit tests for each rule, the signature vector, the posting loop on an in-memory store, a Postgres
integration test (a throwaway local cluster; skipped without Postgres binaries) and an anvil test that deploys `VolOracle`
locally and checks the contract accepts what the engine sends (skipped without `anvil`, `cast` and `forge build` output).
