"""Two-source earnings reconciliation and the buy-block window.

Sources (both free and independent):
  A  `alphavantage`  the daily Alpha Vantage calendar the keeper `earnings` job already ingests.
  B  `company_ir`    dates the company itself published on its investor-relations page, kept by hand in
                     app/src/config/earnings-overrides.json and synced into the `earnings` table by the keeper.

A date is only trusted when both sources agree within one day. This module never invents a date.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Iterable, Sequence

from .bars import ET
from .config import NO_EARNINGS, TAU_SECONDS, WEEKLY

SOURCE_A = "alphavantage"
SOURCE_B = "company_ir"

# Nominal report times in New York time. The sources only say pre or post market.
PRE_AT = time(8, 0)
POST_AT = time(16, 5)
BLOCK_BEFORE = timedelta(minutes=60)
BLOCK_AFTER = timedelta(minutes=30)
DISAGREE_DAYS = 1
UNCONFIRMED_BLOCK = timedelta(hours=24)
# Only block for an unconfirmed report that could matter soon: inside two weekly taus plus two days.
IMMINENT = timedelta(seconds=2 * TAU_SECONDS[WEEKLY]) + timedelta(days=2)


@dataclass(frozen=True)
class EarningsRow:
    symbol: str
    report_date: date
    session: str  # pre | post | unknown
    source: str


@dataclass
class EarningsDecision:
    status: str  # no_earnings | none | confirmed | disagree | missing_source
    report_date: date | None = None
    session: str = "unknown"
    force_block: tuple[int, int] | None = None  # (from, to) unix seconds when buys are blocked pending confirmation
    alerts: list[tuple[str, dict]] = field(default_factory=list)


def _et(d: date, t: time) -> datetime:
    return datetime.combine(d, t, tzinfo=ET)


def report_times(report_date: date, session: str) -> tuple[int, int, int, int]:
    """(report_ts, block_from, block_to, day_end) in unix seconds.

    pre: report 08:00 ET. post: 16:05 ET. unknown: the window spans both, so it holds whichever it turns out to be.
    The block is report - 60 min to report + 30 min; Daily speed stretches it over the whole ET report day elsewhere.
    """
    pre, post = _et(report_date, PRE_AT), _et(report_date, POST_AT)
    if session == "pre":
        report, lo, hi = pre, pre - BLOCK_BEFORE, pre + BLOCK_AFTER
    elif session == "post":
        report, lo, hi = post, post - BLOCK_BEFORE, post + BLOCK_AFTER
    else:
        report, lo, hi = pre, pre - BLOCK_BEFORE, post + BLOCK_AFTER
    day_end = _et(report_date + timedelta(days=1), time(0, 0))
    return int(report.timestamp()), int(lo.timestamp()), int(hi.timestamp()), int(day_end.timestamp())


def _next(rows: Iterable[EarningsRow], today: date, source: str) -> EarningsRow | None:
    upcoming = [r for r in rows if r.source == source and r.report_date >= today]
    return min(upcoming, key=lambda r: r.report_date) if upcoming else None


def reconcile(symbol: str, rows: Sequence[EarningsRow], now: datetime) -> EarningsDecision:
    sym = symbol.upper()
    if sym in NO_EARNINGS:
        return EarningsDecision("no_earnings")
    today = now.astimezone(ET).date()
    a, b = _next(rows, today, SOURCE_A), _next(rows, today, SOURCE_B)
    now_s = int(now.timestamp())
    block = (now_s, now_s + int(UNCONFIRMED_BLOCK.total_seconds()))
    soon = lambda r: r is not None and (r.report_date - today) <= IMMINENT  # noqa: E731
    detail = {
        "alphavantage": a.report_date.isoformat() if a else None,
        "company_ir": b.report_date.isoformat() if b else None,
    }

    if a is None and b is None:
        return EarningsDecision("none", alerts=[("earnings_no_source_dates", detail)])

    if a is None or b is None:
        present = a or b
        missing = SOURCE_A if a is None else SOURCE_B
        dec = EarningsDecision("missing_source", alerts=[("earnings_source_missing", {**detail, "missing": missing})])
        if soon(present):
            dec.force_block = block
        return dec

    if abs((a.report_date - b.report_date).days) > DISAGREE_DAYS:
        dec = EarningsDecision("disagree", alerts=[("earnings_sources_disagree", detail)])
        if soon(a) or soon(b):
            dec.force_block = block
        return dec

    # Agreement. Take the earlier date; trust the company's own session when it states one.
    date_ = min(a.report_date, b.report_date)
    session = b.session if b.session != "unknown" else a.session
    return EarningsDecision("confirmed", report_date=date_, session=session)
