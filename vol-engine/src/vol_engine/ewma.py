"""Exponentially weighted variance (zero-mean, bias-normalised weights)."""

from __future__ import annotations

import math
from typing import Sequence


def decay_for_half_life(half_life_periods: float) -> float:
    """lambda such that a return `half_life_periods` old carries half the weight of the newest one."""
    if half_life_periods <= 0:
        raise ValueError("half-life must be positive")
    return 0.5 ** (1.0 / half_life_periods)


def ewma_variance(returns: Sequence[float], lam: float) -> float:
    """sum(lam^(n-1-i) * r_i^2) / sum(lam^(n-1-i)), computed as an O(n) recursion. NaN for an empty input."""
    if not 0.0 < lam < 1.0:
        raise ValueError("lambda must be in (0, 1)")
    num = 0.0
    den = 0.0
    for r in returns:
        num = lam * num + r * r
        den = lam * den + 1.0
    return num / den if den > 0.0 else math.nan
