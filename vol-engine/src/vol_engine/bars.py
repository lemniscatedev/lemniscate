"""Regular-hours 5-minute bars and overnight gaps from price ticks.

Only REGULAR-session ticks feed realized volatility. EXTENDED ticks (single-provider prints) and every other
session are dropped and counted, so the caller can flag them.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime
from typing import Iterable
from zoneinfo import ZoneInfo

from .config import BAR_SECONDS

ET = ZoneInfo("America/New_York")
REGULAR = "REGULAR"
EXTENDED = "EXTENDED"


@dataclass(frozen=True)
class Tick:
    ts: float  # unix seconds
    spot: float  # USDG per whole Stock Token
    session: str  # REGULAR | EXTENDED | CLOSED | UNKNOWN | HALTED
    fresh: bool = True


@dataclass
class DayBars:
    day: date
    open_px: float
    close_px: float
    closes: list[float]  # 5-minute bar closes, forward-filled between the first and last regular bucket


@dataclass
class RegularSeries:
    days: list[DayBars] = field(default_factory=list)
    excluded_extended: int = 0
    excluded_other: int = 0

    def intraday_returns(self) -> list[float]:
        """5-minute log returns; the first bar of a day has no return, so a gap never leaks in."""
        out: list[float] = []
        for d in self.days:
            c = d.closes
            out.extend(math.log(c[i] / c[i - 1]) for i in range(1, len(c)))
        return out

    def overnight_gaps(self) -> list[float]:
        """Close-to-open log returns between consecutive regular days."""
        return [math.log(b.open_px / a.close_px) for a, b in zip(self.days, self.days[1:])]


def et_day(ts: float) -> date:
    return datetime.fromtimestamp(ts, ET).date()


def build_regular_series(ticks: Iterable[Tick]) -> RegularSeries:
    series = RegularSeries()
    per_day: dict[date, dict[int, float]] = {}
    first: dict[date, tuple[float, float]] = {}
    last: dict[date, tuple[float, float]] = {}
    for t in sorted(ticks, key=lambda x: x.ts):
        if t.session == EXTENDED:
            series.excluded_extended += 1
            continue
        if t.session != REGULAR:
            series.excluded_other += 1
            continue
        if not (t.spot > 0.0) or not math.isfinite(t.spot):
            series.excluded_other += 1
            continue
        d = et_day(t.ts)
        per_day.setdefault(d, {})[int(t.ts // BAR_SECONDS)] = t.spot
        first.setdefault(d, (t.ts, t.spot))
        last[d] = (t.ts, t.spot)
    for d in sorted(per_day):
        buckets = per_day[d]
        lo, hi = min(buckets), max(buckets)
        closes: list[float] = []
        px = buckets[lo]
        for b in range(lo, hi + 1):
            px = buckets.get(b, px)
            closes.append(px)
        series.days.append(DayBars(d, first[d][1], last[d][1], closes))
    return series
