"""Step guard: mirror of VolOracle's 25% step rule so the engine never posts a value the contract would reject."""

from __future__ import annotations

from .config import MAX_STEP_BPS

BPS = 10_000
MIN_POST_INTERVAL_S = 300  # VolOracle.MIN_POST_INTERVAL on mainnet (deploy-time; Settings carries the live value)
ROLLING_WINDOW_S = 3600  # VolOracle.ROLLING_WINDOW on mainnet (= HISTORY x MIN_POST_INTERVAL)
MAX_WINDOW_MOVE_BPS = 5_000  # VolOracle.MAX_WINDOW_MOVE_BPS
HISTORY = 12  # VolOracle.HISTORY ring size


def step_bounds(prior_bps: int, floor_bps: int) -> tuple[int, int]:
    """Allowed [lo, hi] for the next sigma. The reference is max(prior, floor), as in the contract."""
    ref = max(prior_bps, floor_bps)
    allowed = ref * MAX_STEP_BPS // BPS  # diff * 10000 <= ref * 2500  <=>  diff <= floor(ref / 4)
    return max(ref - allowed, floor_bps), ref + allowed


def next_allowed_at(sent: list[tuple[float, int]], interval_s: int = MIN_POST_INTERVAL_S) -> float:
    """Earliest time the contract's rate limit allows the next post. `sent` = (at, sigma), newest first."""
    return sent[0][0] + interval_s if sent else 0.0


def window_bounds(sent: list[tuple[float, int]], now_s: float, floor_bps: int,
                  window_s: int = ROLLING_WINDOW_S) -> tuple[int, int] | None:
    """Mirror of VolOracle.windowBounds: the sigma range allowed by the rolling-hour rule, or None with no history.

    `sent` = (at, sigma) of posts the chain accepted, newest first. In force during [now-1h, now] are every post newer
    than the window start plus the newest one at or before it; the ring keeps the last 12. Each value is lifted to the
    floor. hi = floor(min * 1.5), lo = ceil(max * 0.5).
    """
    start = now_s - window_s if now_s > window_s else 0
    vals: list[int] = []
    for at, sigma in sent[:HISTORY]:
        vals.append(max(sigma, floor_bps))
        if at <= start:
            break
    if not vals:
        return None
    lo = -(-max(vals) * (BPS - MAX_WINDOW_MOVE_BPS) // BPS)
    hi = min(vals) * (BPS + MAX_WINDOW_MOVE_BPS) // BPS
    return lo, hi


def clamp_step(target_bps: int, prior_bps: int | None, floor_bps: int,
               window: tuple[int, int] | None = None) -> tuple[int, bool]:
    """Returns (value, ramped). With no prior post only the floor applies. `window` is the contract's rolling-hour
    range (see window_bounds); it is the hard rule and wins over the 25% step if the two ever disagree."""
    target = max(target_bps, floor_bps)
    value = target
    if prior_bps:
        lo, hi = step_bounds(prior_bps, floor_bps)
        value = min(max(target, lo), hi)
    if window is not None:
        value = min(max(value, window[0]), window[1])
    return value, value != target_bps
