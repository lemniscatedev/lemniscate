"""R01 property: no scheduled sigma path (earnings ramp, weekend ramp, or the weekend inside the earnings ramp) pays a
buy-then-sell round trip at any strike a buyer can hold, for any sigma, event move and speed.

Fuzz over (sigma, E, G, speed, moneyness, call/put). The path is the one the engine posts: the schedule's sigma rounded to
whole bps, hourly steps. Two checks: net of spread, fee and funding every pair of steps loses; and the pure value drift
against funding (no costs) is not positive for pairs at least six hours apart (R01: the earlier bound held for sigma only).
"""

from __future__ import annotations

import math

import numpy as np
import pytest

from vol_engine.config import TAU_SECONDS, WEEKLY
from vol_engine.surface import (
    EARNINGS_DRIFT_SHARE, WEEKEND_DRIFT_SHARE, add_event_variance, earnings_weight, event_ratio, ramp_length_s,
    value_elasticity,
)

from pricing_model import best_drift, best_round_trip

HOUR = 3600
SPOT = 100.0


def posted(sigma: float) -> float:
    return round(sigma * 1e4) / 1e4  # the oracle takes whole bps


def earnings_path(sigma: float, e: float, tau: int, with_weekends: bool, g: float = 0.04):
    """(t, base sigma, session) hourly from the ramp start to the report. With weekends, every 7 days a 48 h CLOSED run
    ramps the weekend variance in on top (as the engine does: it applies it to the earnings-bumped sigma)."""
    length = ramp_length_s(sigma, e, tau)
    n = int(length // HOUR) + 1
    out = []
    for k in range(n + 1):
        t = k * HOUR
        s = add_event_variance(sigma, e, tau, earnings_weight(length, t, sigma, e, tau))
        session = "REGULAR"
        if with_weekends:
            phase = (t - 5 * 86_400) % (7 * 86_400)  # a CLOSED run starts on day 5 of each week
            if phase < 48 * HOUR:
                s = add_event_variance(s, g, tau, earnings_weight(
                    ramp_length_s(s, g, tau, WEEKEND_DRIFT_SHARE), phase, s, g, tau, WEEKEND_DRIFT_SHARE))
                session = "CLOSED"
        out.append((float(t), posted(s), session))
    return out


def weekend_path(sigma: float, g: float, tau: int):
    start = 20 * HOUR  # Friday 20:00
    out = []
    for k in range(-24, 24 * 5 + 1):
        t = k * HOUR
        s = sigma
        session = "REGULAR" if t < 0 else "CLOSED"
        if 0 <= t < 48 * HOUR:
            s = add_event_variance(sigma, g, tau, earnings_weight(
                ramp_length_s(sigma, g, tau, WEEKEND_DRIFT_SHARE), t, sigma, g, tau, WEEKEND_DRIFT_SHARE))
        elif t >= 48 * HOUR:
            session = "EXTENDED"
        out.append((float(t + 24 * HOUR), posted(s), session))
    return out


def cases(seed: int, n: int):
    rng = np.random.default_rng(seed)
    for _ in range(n):
        yield (float(rng.uniform(0.30, 1.0)), float(rng.uniform(0.02, 0.15)), int(rng.integers(0, 2)),
               float(rng.uniform(-0.30, 0.30)), bool(rng.integers(0, 2)))


CORNERS = [(0.30, 0.15, 0, 0.05, True), (0.30, 0.15, 1, 0.10, True), (1.0, 0.02, 0, 0.05, False), (0.30, 0.02, 1, 0.0, True),
           (0.45, 0.07, 0, -0.05, False), (0.55, 0.08, 0, 0.10, True), (0.30, 0.15, 0, 0.20, True), (0.30, 0.15, 1, -0.20, False)]


@pytest.mark.parametrize("sigma,e,speed,m,is_call", CORNERS + list(cases(2026, 24)))
def test_earnings_ramp_net_round_trip_never_profits(sigma, e, speed, m, is_call):
    tau = TAU_SECONDS[speed]
    for weekends in (False, True):
        path = earnings_path(sigma, e, tau, weekends)
        assert best_round_trip(path, SPOT, SPOT * math.exp(m), is_call, tau) <= 0.0


@pytest.mark.parametrize("sigma,e,speed,m,is_call", CORNERS + list(cases(7, 24)))
def test_earnings_ramp_value_drift_stays_under_funding(sigma, e, speed, m, is_call):
    """No costs: the value of a held unit (price times what funding leaves of it) never rises over six hours or more."""
    tau = TAU_SECONDS[speed]
    if abs(m) <= 0.20:  # inside the ramp's band; beyond it the cost floors (min spread, fee) carry the proof above
        path = earnings_path(sigma, e, tau, with_weekends=False)
        assert best_drift(path, SPOT, SPOT * math.exp(m), is_call, tau, 6 * HOUR) <= 1e-3


@pytest.mark.parametrize("sigma,g,speed,m,is_call", [(c[0], c[1] / 3.0, c[2], c[3], c[4]) for c in CORNERS + list(cases(11, 24))])
def test_weekend_ramp_net_round_trip_never_profits(sigma, g, speed, m, is_call):
    tau = TAU_SECONDS[speed]
    assert best_round_trip(weekend_path(sigma, g, tau), SPOT, SPOT * math.exp(m), is_call, tau) <= 0.0


def test_weight_is_monotone_continuous_and_reaches_one_at_the_report():
    for speed in (0, 1):
        tau = TAU_SECONDS[speed]
        for sigma, e in ((0.3, 0.15), (0.5, 0.07), (1.0, 0.02)):
            length = ramp_length_s(sigma, e, tau)
            ws = [earnings_weight(length, t, sigma, e, tau) for t in np.linspace(-1000, length + 1000, 800)]
            assert ws[0] == 0.0 and ws[-1] == 1.0
            assert all(b >= a - 1e-12 for a, b in zip(ws, ws[1:]))
            assert max(b - a for a, b in zip(ws, ws[1:])) < 0.02  # no step


def test_elasticity_grows_with_moneyness_and_the_ramp_is_longer_than_the_money_alone_needs():
    for speed in (0, 1):
        tau = TAU_SECONDS[speed]
        for sigma, e in ((0.3, 0.15), (0.5, 0.07), (1.0, 0.02)):
            assert value_elasticity(sigma, tau, 0.20) > value_elasticity(sigma, tau, 0.0)
            atm_only = tau * value_elasticity(sigma, tau, 0.0) * math.log(event_ratio(sigma, e, tau)) / (2 * EARNINGS_DRIFT_SHARE)
            assert ramp_length_s(sigma, e, tau) > atm_only


def test_poc_r01_daily_otm_call_paid_under_the_linear_two_tau_ramp_and_does_not_now():
    """The review's exploit: NVDA, E = 7 %, sigma 50 %, Daily 5 % OTM call. The F05 ramp (linear over max(2, ln R / 1.5) tau)
    returned +30 % or more (+79 % to +192 % in the review, which skips the skew) to a buyer at the ramp start; the value-drift schedule returns less than nothing."""
    sigma, e, tau = 0.50, 0.07, TAU_SECONDS[0]
    ratio = event_ratio(sigma, e, tau)
    old_len = tau * max(2.0, math.log(ratio) / 1.5)
    old = [(float(t), posted(add_event_variance(sigma, e, tau, t / old_len)), "REGULAR") for t in range(0, int(old_len) + 1, HOUR)]
    k = SPOT * math.exp(0.05)
    assert best_round_trip(old, SPOT, k, True, tau) > 0.25
    assert best_round_trip(earnings_path(sigma, e, tau, True), SPOT, k, True, tau) <= 0.0
