"""Realized volatility: EWMA of 5-minute regular-hours returns plus a separate overnight-gap variance term."""

from __future__ import annotations

import math
from dataclasses import dataclass, field

from .bars import RegularSeries
from .config import BARS_PER_DAY, HALF_LIFE_DAYS, TRADING_DAYS
from .ewma import decay_for_half_life, ewma_variance


@dataclass
class RealizedVol:
    sigma: float  # annualised; 0.0 when there is not enough data (the floor then decides)
    intraday_var_per_bar: float
    gap_var_per_day: float
    n_bars: int
    n_gaps: int
    flags: list[str] = field(default_factory=list)


def realized_vol(series: RegularSeries, speed: int) -> RealizedVol:
    half_life_days = HALF_LIFE_DAYS[speed]
    rets = series.intraday_returns()
    gaps = series.overnight_gaps()
    flags: list[str] = []
    if series.excluded_extended:
        flags.append(f"extended_hours_excluded:{series.excluded_extended}")

    bar_var = ewma_variance(rets, decay_for_half_life(half_life_days * BARS_PER_DAY)) if rets else 0.0
    gap_var = ewma_variance(gaps, decay_for_half_life(half_life_days)) if gaps else 0.0
    if len(rets) < BARS_PER_DAY:
        flags.append("insufficient_bars")
    if not gaps:
        flags.append("no_overnight_gap")

    if len(rets) < BARS_PER_DAY:
        sigma = 0.0
    else:
        daily_var = BARS_PER_DAY * bar_var + gap_var  # R2: the gap enters as its own variance term
        sigma = math.sqrt(TRADING_DAYS * daily_var)
    return RealizedVol(sigma, bar_var, gap_var, len(rets), len(gaps), flags)
