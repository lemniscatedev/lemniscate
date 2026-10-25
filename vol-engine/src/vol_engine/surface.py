"""Base floor, skew, and the earnings and weekend variance bumps (spec section 3, steps 1 to 4)."""

from __future__ import annotations

import math
from functools import lru_cache
from typing import Sequence

import numpy as np

from .config import (
    EARNINGS_MOVE_DEFAULT,
    EARNINGS_MOVES_USED,
    K_CALL,
    K_PUT,
    MIN_EARNINGS_MOVES,
    MIN_WEEKEND_SAMPLES,
    RV_MARKUP,
    WEEKEND_GAP_DEFAULT,
    YEAR_SECONDS,
    floor_for,
)

SKEW_SCALE = 10_000  # k values are stored with 4 decimals
_U32 = 0xFFFFFFFF


def sigma_base(sigma_rv: float, name: str, mega_caps: frozenset[str] | None = None) -> float:
    """R3: max(sigma_RV * 1.15, floor(name))."""
    floor = floor_for(name) if mega_caps is None else floor_for(name, mega_caps)
    return max(sigma_rv * RV_MARKUP, floor)


def skew_sigma(base: float, strike: float, spot: float, k_put: float = K_PUT, k_call: float = K_CALL) -> float:
    """R4: sigma(K) = base * (1 + k_put * max(0, -ln(K/S)) + k_call * max(0, ln(K/S)))."""
    m = math.log(strike / spot)
    return base * (1.0 + k_put * max(0.0, -m) + k_call * max(0.0, m))


def pack_skew_k(k_put: float = K_PUT, k_call: float = K_CALL) -> int:
    """skewK (uint64) = round(k_put * 1e4) << 32 | round(k_call * 1e4). 1.2 and 0.4 give (12000 << 32) | 4000."""
    p, c = round(k_put * SKEW_SCALE), round(k_call * SKEW_SCALE)
    if not (0 <= p <= _U32 and 0 <= c <= _U32):
        raise ValueError("skew coefficient out of range")
    return (p << 32) | c


def unpack_skew_k(packed: int) -> tuple[float, float]:
    return ((packed >> 32) & _U32) / SKEW_SCALE, (packed & _U32) / SKEW_SCALE


def tau_years(tau_s: int) -> float:
    return tau_s / YEAR_SECONDS


def event_ratio(sigma: float, move: float, tau_s: int) -> float:
    """R = sigma_eff^2 / sigma^2 once the event variance is fully on (>= 1)."""
    return 1.0 + move * move / (tau_years(tau_s) * sigma * sigma)


def add_event_variance(sigma: float, move: float, tau_s: int, weight: float = 1.0) -> float:
    """Full weight: sigma_eff^2 = sigma^2 + move^2 / tau, with tau in years (used for both E and G).

    A scheduled event ramps in (F05): sigma_eff^2 = sigma^2 * R^w with R = sigma_eff^2 / sigma^2 at full weight and
    w running 0 to 1 over the ramp. The earnings schedule (`earnings_weight`) keeps the VALUE drift of every buyable
    strike below funding (R01), not only the drift of sigma, so holding through the ramp can never pay.
    """
    w = max(0.0, min(1.0, weight))
    return sigma * event_ratio(sigma, move, tau_s) ** (w / 2.0)


# R01: the ramp keeps the value drift under funding at every strike up to this log distance from spot. The product lists
# +-10 % (GRID_OFFSETS_BPS) and archives a series at 30 % (ARCHIVE_MONEYNESS_BPS in app/src/config/listing.ts). Beyond 20 %
# the option is worth cents: the $0.01 minimum spread and the 3 bps fee (of S) per side exceed anything a round trip can
# earn, which tests/test_ramp_property.py checks out to 30 % for every speed, sigma and move.
RAMP_BAND = 0.20
# Share of the funding rate the value drift may use at the worst strike. The two scheduled ramps can run together (a
# weekend inside an earnings ramp), so their shares add up: 0.6 + 0.3 stays below 1 and leaves room for the spread, the
# fee and the rounding of sigma to whole bps, which keep every pair of (buy, sell) steps strictly negative.
EARNINGS_DRIFT_SHARE = 0.6
WEEKEND_DRIFT_SHARE = 0.3
_RAMP_NODES = 240


def value_elasticity(sigma: float, tau_s: float, moneyness: float) -> float:
    """d ln(time value) / d ln(sigma) of an everlasting option |ln(K/S)| = `moneyness` away from spot (OTM side, which
    is the larger of the two sides). With u^2 = 1/4 + 2 / (sigma^2 tau): (1 - 1 / (4 u^2)) (1 + moneyness u).
    ATM it is below 1; it grows with moneyness and with a small sigma tau."""
    u = math.sqrt(0.25 + 2.0 / (sigma * sigma * tau_s / YEAR_SECONDS))
    return (1.0 - 0.25 / (u * u)) * (1.0 + moneyness * u)


@lru_cache(maxsize=512)
def _ramp_table(sigma: float, move: float, tau_s: int, share: float) -> tuple[tuple[float, ...], float]:
    """(remaining[k], total): seconds before the report at which the weight is w_k = k / N, for k = 0..N.

    Funding shrinks the units at rate r / tau, and for any strike r = (time value) / V. Holding through the ramp pays
    nothing when d ln(time value) / dt <= share / tau at every strike. With ln sigma_eff = ln sigma + (w / 2) ln R
    that is dw/dt <= 2 share / (tau eps ln R), eps = the largest elasticity over the band (the strike at RAMP_BAND).
    """
    ratio = event_ratio(sigma, move, tau_s)
    ln_r = math.log(ratio)
    step = 1.0 / _RAMP_NODES
    rem = [0.0] * (_RAMP_NODES + 1)
    for k in range(_RAMP_NODES, 0, -1):  # integrate backwards from the report (w = 1)
        w_mid = (k - 0.5) * step
        eps = value_elasticity(sigma * ratio ** (w_mid / 2.0), tau_s, RAMP_BAND)
        rem[k - 1] = rem[k] + tau_s * eps * ln_r * step / (2.0 * share)
    return tuple(rem), rem[0]


def ramp_length_s(sigma: float, move: float, tau_s: int, share: float = EARNINGS_DRIFT_SHARE) -> float:
    """Seconds before the report at which the earnings variance starts to ramp in (weight 0)."""
    if event_ratio(sigma, move, tau_s) <= 1.0 + 1e-12:
        return 0.0
    return _ramp_table(round(sigma, 6), round(move, 6), int(tau_s), share)[1]


def earnings_weight(report_ts: float, now_s: float, sigma: float, move: float, tau_s: int,
                    share: float = EARNINGS_DRIFT_SHARE) -> float:
    """0 at `ramp_length_s` before the report, 1 at the report (and after, while the buy block lasts).

    The weight follows the value-drift bound of `_ramp_table`, slow where a far strike gains the most from a rise of sigma
    and quicker where it gains less, so the worst strike loses (after funding) at every step of the ramp."""
    if now_s >= report_ts:
        return 1.0
    if event_ratio(sigma, move, tau_s) <= 1.0 + 1e-12:
        return 1.0
    rem, total = _ramp_table(round(sigma, 6), round(move, 6), int(tau_s), share)
    left = report_ts - now_s
    if left >= total:
        return 0.0
    # rem is decreasing in k; find the bracket with rem[k] >= left > rem[k+1] and interpolate linearly in time.
    lo, hi = 0, _RAMP_NODES
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if rem[mid] >= left:
            lo = mid
        else:
            hi = mid
    span = rem[lo] - rem[hi]
    frac = (rem[lo] - left) / span if span > 0 else 1.0
    return (lo + frac) / _RAMP_NODES


def earnings_move(name: str, past_moves: Sequence[float]) -> tuple[float, list[str]]:
    """E = median |1-day move| over the last 8 reports. Fewer than 4 reports: conservative default, flagged."""
    recent = [abs(m) for m in past_moves][-EARNINGS_MOVES_USED:]
    if len(recent) < MIN_EARNINGS_MOVES:
        default = EARNINGS_MOVE_DEFAULT.get(name.upper(), EARNINGS_MOVE_DEFAULT["default"])
        return default, ["earnings_move_default"]
    return float(np.median(recent)), []


def weekend_move(name: str, gaps: Sequence[float]) -> tuple[float, list[str]]:
    """G = 90th percentile of |Friday close to Monday open|; fewer than 26 weeks: conservative default, flagged."""
    samples = [abs(g) for g in gaps]
    if len(samples) < MIN_WEEKEND_SAMPLES:
        default = WEEKEND_GAP_DEFAULT.get(name.upper(), WEEKEND_GAP_DEFAULT["default"])
        return default, ["weekend_move_default"]
    return float(np.percentile(samples, 90)), []
