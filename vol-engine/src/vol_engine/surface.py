"""Base floor, skew, and the earnings and weekend variance bumps (spec section 3, steps 1 to 4)."""

from __future__ import annotations

import math
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
    w running 0 to 1 over the ramp. Variance then grows geometrically, so value drift per hour is 0.5 ln(R) dw, and
    `ramp_length_s` keeps that below funding (V / tau): holding through the ramp can never pay.
    """
    w = max(0.0, min(1.0, weight))
    return sigma * event_ratio(sigma, move, tau_s) ** (w / 2.0)


def ramp_length_s(sigma: float, move: float, tau_s: int) -> float:
    """Ramp length: at least 2 tau, longer when ln R is large so 0.5 ln(R) / length stays <= 0.75 / tau."""
    return tau_s * max(2.0, math.log(event_ratio(sigma, move, tau_s)) / 1.5)


def earnings_weight(report_ts: float, now_s: float, length_s: float) -> float:
    """0 `length_s` before the report, 1 at the report (and after, while the buy block lasts). Linear in time."""
    if now_s >= report_ts:
        return 1.0
    return max(0.0, 1.0 - (report_ts - now_s) / length_s)


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
