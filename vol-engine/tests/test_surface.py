import math

import numpy as np

from vol_engine.config import DAILY, TAU_SECONDS, WEEKLY
from vol_engine.surface import (
    add_event_variance, earnings_move, pack_skew_k, sigma_base, skew_sigma, unpack_skew_k, weekend_move,
)


def test_sigmaBaseFloor():
    assert sigma_base(0.10, "NVDA") == 0.30  # 0.115 < floor
    assert abs(sigma_base(0.60, "TSLA") - 0.69) < 1e-12  # 0.6 * 1.15 above the floor
    assert sigma_base(0.10, "ABCD") == 0.45  # non mega-cap floor
    assert sigma_base(0.10, "ABCD", frozenset({"ABCD"})) == 0.30  # configurable list
    assert sigma_base(0.0, "SPY") == 0.30


def test_skewFormula():
    base, s = 0.40, 100.0
    # ATM: no skew. Puts (K < S) use k_put = 1.2, calls (K > S) use k_call = 0.4.
    assert skew_sigma(base, 100.0, s) == base
    k = 90.0
    assert abs(skew_sigma(base, k, s) - base * (1 + 1.2 * (-math.log(0.9)))) < 1e-15
    k = 110.0
    assert abs(skew_sigma(base, k, s) - base * (1 + 0.4 * math.log(1.1))) < 1e-15
    # Hand-computed: ln(0.8) = -0.2231435513 -> 0.4 * (1 + 1.2 * 0.2231435513)
    assert abs(skew_sigma(0.4, 80.0, 100.0) - 0.5071089) < 1e-7
    # Puts are always priced above calls at the same distance.
    assert skew_sigma(base, 90.0, 100.0) > skew_sigma(base, 100.0 / 0.9, 100.0)


def test_skewK_roundtrip():
    packed = pack_skew_k()
    assert packed == (12000 << 32) | 4000
    assert unpack_skew_k(packed) == (1.2, 0.4)
    assert packed < 2**64


def test_earningsBump_formula():
    tau_d = TAU_SECONDS[DAILY]
    sigma, e = 0.50, 0.06
    got = add_event_variance(sigma, e, tau_d)
    assert abs(got**2 - (sigma**2 + e**2 / (1 / 365))) < 1e-12
    assert got > sigma
    # Weekly tau is 7x longer so the same move adds 7x less variance.
    w = add_event_variance(sigma, e, TAU_SECONDS[WEEKLY])
    assert abs((w**2 - sigma**2) * 7 - (got**2 - sigma**2)) < 1e-12


def test_earningsBump_E_is_median_of_last_8():
    moves = [0.20, 0.01, 0.02, 0.03, 0.04, 0.05, 0.06, 0.07, 0.08, -0.09]
    e, flags = earnings_move("NVDA", moves)
    assert e == float(np.median([0.03, 0.04, 0.05, 0.06, 0.07, 0.08, 0.09, 0.02]))
    assert flags == []
    e2, f2 = earnings_move("NVDA", [0.05, 0.06])
    assert f2 == ["earnings_move_default"] and e2 > 0


def test_weekendBump_G_p90_and_default_flag():
    gaps = [(-1) ** i * (i + 1) / 1000 for i in range(30)]
    g, flags = weekend_move("SPY", gaps)
    assert flags == [] and abs(g - float(np.percentile([abs(x) for x in gaps], 90))) < 1e-15
    g2, f2 = weekend_move("SPY", gaps[:25])
    assert f2 == ["weekend_move_default"] and g2 > 0
