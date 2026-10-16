"""PgStore against a throwaway local Postgres cluster (skipped when Postgres binaries are not installed)."""

import os
import socket
import subprocess
import time
from datetime import date, datetime, timezone
from pathlib import Path

import pytest

from vol_engine.bars import Tick
from vol_engine.config import Settings
from vol_engine.earnings import SOURCE_A, SOURCE_B
from vol_engine.engine import run_cycle
from vol_engine.history import History
from vol_engine.sender import DryRunSender
from vol_engine.store import Intent, PgStore

from helpers import ANVIL_KEY, ORACLE, STOCKS, synthetic_ticks, weekdays

PG_BIN = next((Path(p) for p in ("/opt/homebrew/opt/postgresql@16/bin", "/opt/homebrew/opt/postgresql@18/bin", "/usr/local/opt/postgresql@16/bin") if (Path(p) / "initdb").exists()), None)
MIGRATION = Path(__file__).resolve().parents[2] / "app" / "drizzle" / "0009_vol_engine.sql"
pytestmark = pytest.mark.skipif(PG_BIN is None, reason="needs local postgres binaries")

BASE_DDL = """
CREATE TABLE ticks (stock_token text NOT NULL, name text, ts timestamptz NOT NULL, block bigint NOT NULL,
  spot numeric(78,18) NOT NULL, session text NOT NULL, fresh boolean NOT NULL, buys_paused boolean NOT NULL DEFAULT false,
  price_updated_at timestamptz, sigma_daily_bps integer, sigma_weekly_bps integer, vol_stale boolean, PRIMARY KEY (stock_token, ts));
CREATE TABLE vol_posts (tx_hash text NOT NULL, log_index integer NOT NULL, block bigint NOT NULL, ts timestamptz NOT NULL,
  stock_token text NOT NULL, name text, speed text NOT NULL, sigma_bps integer NOT NULL, skew_k numeric(78,0) NOT NULL,
  event_bump_bps integer NOT NULL, buy_block_from timestamptz, buy_block_to timestamptz, valid_until timestamptz NOT NULL,
  nonce numeric(78,0) NOT NULL, sig text, PRIMARY KEY (tx_hash, log_index));
CREATE TABLE earnings (symbol text NOT NULL, report_date date NOT NULL, session text NOT NULL DEFAULT 'unknown',
  fiscal_date_ending date, source text NOT NULL, fetched_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY (symbol, report_date, source));
"""


@pytest.fixture(scope="module")
def dsn(tmp_path_factory):
    d = tmp_path_factory.mktemp("pg")
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        port = s.getsockname()[1]
    subprocess.run([PG_BIN / "initdb", "-D", d / "data", "-U", "vol", "--auth=trust", "-E", "UTF8", "--locale=C"], check=True, capture_output=True,
                   env={**os.environ, "LC_ALL": "C"})
    proc = subprocess.Popen([PG_BIN / "postgres", "-D", d / "data", "-p", str(port), "-c", "unix_socket_directories=", "-c", "listen_addresses=127.0.0.1"],
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env={**os.environ, "LC_ALL": "C"})
    url = f"postgres://vol@127.0.0.1:{port}/postgres"
    import psycopg

    for _ in range(100):
        try:
            conn = psycopg.connect(url, autocommit=True)
            break
        except Exception:
            time.sleep(0.2)
    else:
        proc.terminate()
        pytest.fail("postgres did not start")
    conn.execute(BASE_DDL)
    for stmt in MIGRATION.read_text().split("--> statement-breakpoint"):
        conn.execute(stmt)
    conn.close()
    try:
        yield url
    finally:
        proc.terminate()
        proc.wait(timeout=20)


def test_reader_connection_is_read_only(dsn):
    store = PgStore(dsn)
    try:
        import psycopg

        with pytest.raises(psycopg.errors.ReadOnlySqlTransaction):
            store._reader.execute("INSERT INTO vol_alerts (name, kind) VALUES ('x', 'y')")
    finally:
        store.close()


def test_full_cycle_against_postgres(dsn):
    import psycopg

    now = datetime.now(timezone.utc)
    stock = STOCKS["TSLA"]
    ticks, _, _ = synthetic_ticks(weekdays(date(2026, 9, 14), 21), seed=2, bar_vol=0.0012)
    ticks.append(Tick(now.timestamp() - 30, ticks[-1].spot, "REGULAR", True))
    with psycopg.connect(dsn, autocommit=True) as w:
        with w.cursor() as cur:
            cur.executemany(
                "INSERT INTO ticks (stock_token, name, ts, block, spot, session, fresh) VALUES (%s,'TSLA',to_timestamp(%s),1,%s,%s,%s) ON CONFLICT DO NOTHING",
                [(stock, t.ts, t.spot, t.session, t.fresh) for t in ticks],
            )
        today = now.date().isoformat()
        w.execute("INSERT INTO earnings (symbol, report_date, session, source) VALUES ('TSLA', %s, 'post', %s), ('TSLA', %s, 'post', %s)",
                  (today, SOURCE_A, today, SOURCE_B))
        w.execute("INSERT INTO vol_posts VALUES ('0xabc', 0, 5, now() - interval '1 hour', %s, 'TSLA', 'DAILY', 5000, 12, 0, NULL, NULL, now(), 41, NULL)", (stock,))

    store = PgStore(dsn)
    try:
        s = Settings(signer_key=ANVIL_KEY, oracle_address=ORACLE, chain_id=31337, names=("TSLA",))
        assert store.stock_token("TSLA") == stock and store.stock_token("NOPE") is None
        assert len(store.ticks(stock, 0)) <= len(ticks)  # last tick per 5-minute bucket
        assert store.reference(stock, "DAILY", True) == 5000 and store.max_nonce(stock, "DAILY") == 41
        plans = run_cycle(now, store, DryRunSender(), s, History(), force=True)
        daily = [p for p in plans if p.speed == 0][0]
        assert daily.post.nonce == 42  # continues after the indexed on-chain nonce
        assert abs(daily.post.sigma_bps - 5000) * 4 <= 5000  # step guard against the indexed prior
        assert daily.ramped or daily.post.sigma_bps == daily.target_bps
        row = store.last_intent(stock, "DAILY")
        assert row is not None and row.status == "dry_run" and row.nonce == 42 and row.sigma_bps == daily.post.sigma_bps
        assert row.sig.startswith("0x") and len(row.sig) == 132
        # Dry-run intents do not count as a reference when sending.
        assert store.reference(stock, "DAILY", False) == 5000
        store.write_alert("TSLA", "k", {"a": 1})
        assert store.last_alert("TSLA", "k")[1] == {"a": 1}
        # Unique (stock, speed, nonce): a replayed intent is ignored, not duplicated.
        store.write_intent(Intent(stock, "TSLA", "DAILY", 1, 1, 0, 0, 0, 1, 42, "0x", "0x", "dry_run"))
        with psycopg.connect(dsn) as c:
            assert c.execute("SELECT count(*) FROM vol_post_intents WHERE speed='DAILY' AND nonce=42").fetchone()[0] == 1
        # recent_sent: only status 'sent' intents, newest first (dry_run row above is excluded).
        assert store.recent_sent(stock, "DAILY", now.timestamp()) == []
        store.write_intent(Intent(stock, "TSLA", "DAILY", 4321, 1, 0, 0, 0, 1, 90, "0x", "0x", "pending"))
        store.mark_intent(stock, "DAILY", 90, "sent", "0x" + "11" * 32)
        rows = store.recent_sent(stock, "DAILY", now.timestamp())
        assert len(rows) == 1 and rows[0][1] == 4321 and abs(rows[0][0] - now.timestamp()) < 120
    finally:
        store.close()
