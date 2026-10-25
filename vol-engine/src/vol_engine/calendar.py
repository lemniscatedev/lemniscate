"""NYSE closed runs, mirroring contracts/src/libs/NyseCalendar.sol: CLOSED lasts from 20:00 ET on a trading day to 20:00 ET
on the day before the next trading day (a normal weekend is Friday 20:00 to Sunday 20:00; a holiday extends it).

Holiday list: same source and years as app/src/keeper/holidays.ts (checked 2026-09-30, https://www.nyse.com/trade/hours-calendars).
Past the last listed year only weekends are known; the engine then falls back to the session of the newest tick.
"""

from __future__ import annotations

from datetime import date, datetime, time, timedelta

from .bars import ET

CALENDAR_YEARS = frozenset({2026, 2027, 2028})
FULL_DAY_CLOSURES = frozenset(date.fromisoformat(d) for d in (
    "2026-01-01", "2026-01-19", "2026-02-16", "2026-04-03", "2026-05-25", "2026-06-19", "2026-07-03", "2026-09-07",
    "2026-11-26", "2026-12-25",
    "2027-01-01", "2027-01-18", "2027-02-15", "2027-03-26", "2027-05-31", "2027-06-18", "2027-07-05", "2027-09-06",
    "2027-11-25", "2027-12-24",
    "2028-01-17", "2028-02-21", "2028-04-14", "2028-05-29", "2028-06-19", "2028-07-04", "2028-09-04", "2028-11-23",
    "2028-12-25",
))
CLOSE_HOUR_ET = 20


def is_trading_day(d: date) -> bool:
    return d.weekday() < 5 and d not in FULL_DAY_CLOSURES


def _at_close(d: date) -> datetime:
    return datetime.combine(d, time(CLOSE_HOUR_ET, 0), tzinfo=ET)


def closed_run(now: datetime) -> tuple[datetime, datetime] | None:
    """The CLOSED run that contains `now` or is the next one to start (within 10 days), as (start, end) in ET."""
    today = now.astimezone(ET).date()
    d = today - timedelta(days=5)
    for _ in range(20):
        if is_trading_day(d):
            nxt = d + timedelta(days=1)
            while not is_trading_day(nxt):
                nxt += timedelta(days=1)
            if nxt - d > timedelta(days=1):  # at least one non-trading day follows: the market closes at 20:00 ET
                start, end = _at_close(d), _at_close(nxt - timedelta(days=1))
                if end > now.astimezone(ET):
                    return start, end
            d = nxt
        else:
            d += timedelta(days=1)
    return None


def closed_run_progress(now: datetime) -> float | None:
    """0..1 through the CLOSED run that contains `now`; None when `now` is not inside one."""
    run = closed_run(now)
    if run is None:
        return None
    start, end = run
    here = now.astimezone(ET)
    if not (start <= here < end):
        return None
    return (here - start) / (end - start)


def closed_run_elapsed_s(now: datetime) -> float | None:
    """Seconds since the CLOSED run that contains `now` began; None when `now` is not inside one."""
    run = closed_run(now)
    if run is None:
        return None
    start, end = run
    here = now.astimezone(ET)
    if not (start <= here < end):
        return None
    return (here - start).total_seconds()
