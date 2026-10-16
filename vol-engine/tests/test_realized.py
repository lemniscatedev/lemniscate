import math

import numpy as np

from vol_engine.bars import Tick, build_regular_series
from vol_engine.config import BARS_PER_DAY, DAILY, WEEKLY, TRADING_DAYS
from vol_engine.ewma import decay_for_half_life
from vol_engine.realized import realized_vol

from helpers import et_ts, synthetic_ticks, weekdays
from datetime import date


def reference_sigma(closes_by_day, opens, half_life_days):
    """Plain numpy, written independently of the library: explicit weights, no recursion."""
    rets = np.concatenate([np.diff(np.log(np.array(c))) for c in closes_by_day])
    lam = 0.5 ** (1.0 / (half_life_days * BARS_PER_DAY))
    w = lam ** np.arange(len(rets) - 1, -1, -1)
    bar_var = np.sum(w * rets**2) / np.sum(w)
    gaps = np.array([math.log(opens[i] / closes_by_day[i - 1][-1]) for i in range(1, len(opens))])
    lg = 0.5 ** (1.0 / half_life_days)
    wg = lg ** np.arange(len(gaps) - 1, -1, -1)
    gap_var = np.sum(wg * gaps**2) / np.sum(wg)
    return math.sqrt(TRADING_DAYS * (BARS_PER_DAY * bar_var + gap_var)), bar_var, gap_var


def test_ewmaMatchesReference_daily_and_weekly():
    days = weekdays(date(2026, 9, 14), 25)
    ticks, closes, opens = synthetic_ticks(days, seed=7)
    series = build_regular_series(ticks)
    for speed, hl in ((DAILY, 1.0), (WEEKLY, 5.0)):
        want, want_bar, want_gap = reference_sigma(closes, opens, hl)
        got = realized_vol(series, speed)
        assert abs(got.sigma - want) < 1e-9
        assert abs(got.intraday_var_per_bar - want_bar) < 1e-9 * max(1.0, want_bar)
        assert abs(got.gap_var_per_day - want_gap) < 1e-9


def test_ewmaMatchesReference_lambda_from_half_life():
    assert abs(decay_for_half_life(78) ** 78 - 0.5) < 1e-12
    assert abs(decay_for_half_life(390) ** 390 - 0.5) < 1e-12


def test_extendedHoursExcludedAndFlagged():
    days = weekdays(date(2026, 9, 14), 10)
    clean, closes, opens = synthetic_ticks(days, seed=3)
    noisy, _, _ = synthetic_ticks(days, seed=3, extended=True)
    a = realized_vol(build_regular_series(clean), DAILY)
    series = build_regular_series(noisy)
    b = realized_vol(series, DAILY)
    assert series.excluded_extended == 2 * len(days)
    assert b.sigma == a.sigma  # extended prints change nothing
    assert any(f.startswith("extended_hours_excluded:") for f in b.flags)
    assert not any(f.startswith("extended_hours_excluded") for f in a.flags)


def test_overnightGapTerm_known_gap():
    # Flat intraday prices, one known overnight gap: the whole variance must come from the gap term.
    d1, d2 = date(2026, 10, 5), date(2026, 10, 6)
    ticks = []
    for d, px in ((d1, 100.0), (d2, 110.0)):
        t0 = et_ts(d, 9, 30)
        ticks += [Tick(t0 + 300 * i + 1, px, "REGULAR") for i in range(BARS_PER_DAY)]
    series = build_regular_series(ticks)
    assert series.overnight_gaps() == [math.log(1.1)]
    rv = realized_vol(series, DAILY)
    assert rv.intraday_var_per_bar == 0.0
    assert abs(rv.gap_var_per_day - math.log(1.1) ** 2) < 1e-15
    assert abs(rv.sigma - math.sqrt(TRADING_DAYS) * abs(math.log(1.1))) < 1e-12


def test_gap_never_leaks_into_intraday_returns():
    d1, d2 = date(2026, 10, 5), date(2026, 10, 6)
    ticks = [Tick(et_ts(d1, 9, 30) + 1, 100.0, "REGULAR"), Tick(et_ts(d1, 9, 35) + 1, 100.0, "REGULAR"),
             Tick(et_ts(d2, 9, 30) + 1, 150.0, "REGULAR"), Tick(et_ts(d2, 9, 35) + 1, 150.0, "REGULAR")]
    assert build_regular_series(ticks).intraday_returns() == [0.0, 0.0]


def test_short_history_is_flagged_and_gives_zero_sigma():
    ticks, _, _ = synthetic_ticks(weekdays(date(2026, 10, 5), 1))
    rv = realized_vol(build_regular_series(ticks), DAILY)
    assert "insufficient_bars" in rv.flags and "no_overnight_gap" in rv.flags
    assert rv.sigma == 0.0
