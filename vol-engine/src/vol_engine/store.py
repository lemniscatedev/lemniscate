"""Data access. The engine reads ticks, earnings and prior posts, and writes intent and alert rows only."""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
from typing import Any, Protocol

from .bars import Tick
from .earnings import EarningsRow


@dataclass
class Intent:
    stock: str
    name: str
    speed: str  # DAILY | WEEKLY
    sigma_bps: int
    skew_k: int
    event_bump_bps: int
    buy_block_from: int
    buy_block_to: int
    valid_until: int
    nonce: int
    digest: str
    sig: str
    status: str  # dry_run | pending | sent | failed
    flags: list[str] = field(default_factory=list)
    tx_hash: str | None = None
    created_at: float = 0.0


class Store(Protocol):
    def stock_token(self, name: str) -> str | None: ...
    def ticks(self, stock: str, since_ts: float) -> list[Tick]: ...
    def earnings(self, symbol: str) -> list[EarningsRow]: ...
    def reference(self, stock: str, speed: str, include_dry_run: bool) -> int | None: ...
    def max_nonce(self, stock: str, speed: str) -> int: ...
    def last_intent(self, stock: str, speed: str) -> Intent | None: ...
    def recent_sent(self, stock: str, speed: str, now_s: float) -> list[tuple[float, int]]: ...
    def write_intent(self, intent: Intent) -> None: ...
    def mark_intent(self, stock: str, speed: str, nonce: int, status: str, tx_hash: str | None) -> None: ...
    def last_alert(self, name: str, kind: str) -> tuple[float, dict] | None: ...
    def write_alert(self, name: str, kind: str, detail: dict, ts: float | None = None) -> None: ...


class MemoryStore:
    """In-memory store for tests and dry fixtures."""

    def __init__(self) -> None:
        self.tick_rows: dict[str, list[Tick]] = {}
        self.stocks: dict[str, str] = {}
        self.earnings_rows: list[EarningsRow] = []
        self.chain_posts: dict[tuple[str, str], tuple[int, int, float]] = {}  # (sigma, nonce, ts)
        self.intents: list[Intent] = []
        self.alerts: list[tuple[float, str, str, dict]] = []
        self.clock = 0.0

    def stock_token(self, name: str) -> str | None:
        return self.stocks.get(name)

    def ticks(self, stock: str, since_ts: float) -> list[Tick]:
        return [t for t in self.tick_rows.get(stock, []) if t.ts >= since_ts]

    def earnings(self, symbol: str) -> list[EarningsRow]:
        return [r for r in self.earnings_rows if r.symbol == symbol]

    def reference(self, stock: str, speed: str, include_dry_run: bool) -> int | None:
        cands: list[tuple[float, int]] = []
        if (stock, speed) in self.chain_posts:
            s, _, ts = self.chain_posts[(stock, speed)]
            cands.append((ts, s))
        ok = {"sent"} | ({"dry_run"} if include_dry_run else set())
        cands += [(i.created_at, i.sigma_bps) for i in self.intents if i.stock == stock and i.speed == speed and i.status in ok]
        return max(cands)[1] if cands else None

    def max_nonce(self, stock: str, speed: str) -> int:
        n = [self.chain_posts[(stock, speed)][1]] if (stock, speed) in self.chain_posts else []
        return max(n + [i.nonce for i in self.intents if i.stock == stock and i.speed == speed], default=0)

    def last_intent(self, stock: str, speed: str) -> Intent | None:
        mine = [i for i in self.intents if i.stock == stock and i.speed == speed and i.status != "failed"]
        return max(mine, key=lambda i: i.nonce) if mine else None

    def recent_sent(self, stock: str, speed: str, now_s: float) -> list[tuple[float, int]]:
        """(sent_at, sigma_bps) of sent intents, newest first, at most the contract's ring size (12)."""
        mine = sorted(((i.created_at, i.sigma_bps) for i in self.intents
                       if i.stock == stock and i.speed == speed and i.status == "sent"), reverse=True)
        return mine[:12]

    def write_intent(self, intent: Intent) -> None:
        self.intents.append(intent)

    def mark_intent(self, stock: str, speed: str, nonce: int, status: str, tx_hash: str | None) -> None:
        for i in self.intents:
            if (i.stock, i.speed, i.nonce) == (stock, speed, nonce):
                i.status, i.tx_hash = status, tx_hash

    def last_alert(self, name: str, kind: str) -> tuple[float, dict] | None:
        mine = [(ts, d) for ts, n, k, d in self.alerts if n == name and k == kind]
        return max(mine, key=lambda x: x[0]) if mine else None

    def write_alert(self, name: str, kind: str, detail: dict, ts: float | None = None) -> None:
        self.alerts.append((self.clock if ts is None else ts, name, kind, detail))


def _ts(dt: datetime) -> float:
    return dt.timestamp()


def _dt(ts: float) -> datetime | None:
    return datetime.fromtimestamp(ts, timezone.utc) if ts else None


class PgStore:
    """Postgres store. Two connections: a read-only one for ticks/earnings/vol_posts, a writer for intents and alerts."""

    def __init__(self, database_url: str) -> None:
        import psycopg

        # The server enforces read-only for the whole session (psycopg's read_only flag does not apply in autocommit).
        self._reader: Any = psycopg.connect(database_url, autocommit=True, options="-c default_transaction_read_only=on")
        self._writer: Any = psycopg.connect(database_url, autocommit=True)

    def close(self) -> None:
        self._reader.close()
        self._writer.close()

    def stock_token(self, name: str) -> str | None:
        r = self._reader.execute("SELECT stock_token FROM ticks WHERE name = %s ORDER BY ts DESC LIMIT 1", (name,)).fetchone()
        return r[0].lower() if r else None

    def ticks(self, stock: str, since_ts: float) -> list[Tick]:
        # Last snapshot per 5-minute bucket keeps the transfer small on a busy table.
        sql = """
            SELECT DISTINCT ON (b) extract(epoch from ts)::float8, spot::float8, session, fresh FROM (
              SELECT ts, spot, session, fresh, floor(extract(epoch from ts) / 300) AS b
              FROM ticks WHERE stock_token = %s AND ts >= to_timestamp(%s)
            ) t ORDER BY b, ts DESC"""
        rows = self._reader.execute(sql, (stock, since_ts)).fetchall()
        return sorted((Tick(r[0], r[1], r[2], r[3]) for r in rows), key=lambda t: t.ts)

    def earnings(self, symbol: str) -> list[EarningsRow]:
        rows = self._reader.execute(
            "SELECT symbol, report_date, session, source FROM earnings WHERE symbol = %s AND report_date >= current_date - 1",
            (symbol,),
        ).fetchall()
        return [EarningsRow(r[0], r[1] if isinstance(r[1], date) else date.fromisoformat(str(r[1])), r[2], r[3]) for r in rows]

    def reference(self, stock: str, speed: str, include_dry_run: bool) -> int | None:
        chain = self._reader.execute(
            "SELECT sigma_bps, extract(epoch from ts)::float8 FROM vol_posts WHERE stock_token = %s AND speed = %s ORDER BY ts DESC LIMIT 1",
            (stock, speed),
        ).fetchone()
        statuses = ["sent"] + (["dry_run"] if include_dry_run else [])
        intent = self._reader.execute(
            "SELECT sigma_bps, extract(epoch from created_at)::float8 FROM vol_post_intents "
            "WHERE stock_token = %s AND speed = %s AND status = ANY(%s) ORDER BY created_at DESC LIMIT 1",
            (stock, speed, statuses),
        ).fetchone()
        cands = [c for c in (chain, intent) if c]
        return int(max(cands, key=lambda c: c[1])[0]) if cands else None

    def max_nonce(self, stock: str, speed: str) -> int:
        a = self._reader.execute("SELECT coalesce(max(nonce), 0) FROM vol_posts WHERE stock_token = %s AND speed = %s", (stock, speed)).fetchone()[0]
        b = self._reader.execute("SELECT coalesce(max(nonce), 0) FROM vol_post_intents WHERE stock_token = %s AND speed = %s", (stock, speed)).fetchone()[0]
        return int(max(a, b))

    def last_intent(self, stock: str, speed: str) -> Intent | None:
        r = self._reader.execute(
            "SELECT sigma_bps, skew_k, event_bump_bps, extract(epoch from buy_block_from), extract(epoch from buy_block_to), "
            "extract(epoch from valid_until), nonce, digest, sig, status, name, tx_hash, extract(epoch from created_at) "
            "FROM vol_post_intents WHERE stock_token = %s AND speed = %s AND status <> 'failed' ORDER BY nonce DESC LIMIT 1",
            (stock, speed),
        ).fetchone()
        if not r:
            return None
        return Intent(stock, r[10] or "", speed, r[0], int(r[1]), r[2], int(r[3] or 0), int(r[4] or 0), int(r[5]), int(r[6]),
                      r[7], r[8], r[9], [], r[11], float(r[12]))

    def recent_sent(self, stock: str, speed: str, now_s: float) -> list[tuple[float, int]]:
        rows = self._reader.execute(
            "SELECT extract(epoch from created_at)::float8, sigma_bps FROM vol_post_intents "
            "WHERE stock_token = %s AND speed = %s AND status = 'sent' ORDER BY created_at DESC LIMIT 12",
            (stock, speed),
        ).fetchall()
        return [(float(r[0]), int(r[1])) for r in rows]

    def write_intent(self, i: Intent) -> None:
        self._writer.execute(
            "INSERT INTO vol_post_intents (stock_token, name, speed, sigma_bps, skew_k, event_bump_bps, buy_block_from, buy_block_to, "
            "valid_until, nonce, digest, sig, status, flags) VALUES (%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s,%s::jsonb) "
            "ON CONFLICT (stock_token, speed, nonce) DO NOTHING",
            (i.stock, i.name, i.speed, i.sigma_bps, i.skew_k, i.event_bump_bps, _dt(i.buy_block_from), _dt(i.buy_block_to),
             _dt(i.valid_until), i.nonce, i.digest, i.sig, i.status, json.dumps(i.flags)),
        )

    def mark_intent(self, stock: str, speed: str, nonce: int, status: str, tx_hash: str | None) -> None:
        self._writer.execute(
            "UPDATE vol_post_intents SET status = %s, tx_hash = %s WHERE stock_token = %s AND speed = %s AND nonce = %s",
            (status, tx_hash, stock, speed, nonce),
        )

    def last_alert(self, name: str, kind: str) -> tuple[float, dict] | None:
        r = self._reader.execute(
            "SELECT extract(epoch from ts)::float8, detail FROM vol_alerts WHERE name = %s AND kind = %s ORDER BY ts DESC LIMIT 1", (name, kind)
        ).fetchone()
        return (r[0], r[1]) if r else None

    def write_alert(self, name: str, kind: str, detail: dict, ts: float | None = None) -> None:
        self._writer.execute("INSERT INTO vol_alerts (name, kind, detail) VALUES (%s,%s,%s::jsonb)", (name, kind, json.dumps(detail)))
