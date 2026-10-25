"""Float model of the engine's price, spread, fee and funding, used to prove that no scheduled sigma path pays a
buy-then-sell round trip (F05, R01). Mirrors EverlastingMath.sol, EngineHelper (spread) and Funding.sol."""

from __future__ import annotations

import math

import numpy as np

from vol_engine.config import K_CALL, K_PUT, YEAR_SECONDS

SPREAD_ATM, SPREAD_FAR, FAR_M = 0.0150, 0.0400, 0.30
SESSION_MULT = {"REGULAR": 1.0, "EXTENDED": 1.5, "CLOSED": 3.0}
FEE = 0.0003  # per side, share of S
MIN_SPREAD = 0.01  # USD per unit


def u_of(sigma: float, tau_s: float) -> float:
    return math.sqrt(0.25 + 2.0 / (sigma * sigma * tau_s / YEAR_SECONDS))


def time_value(s: float, k: float, sigma: float, tau_s: float) -> float:
    u = u_of(sigma, tau_s)
    lnx = math.log(s / k)
    e = (0.5 + u) if s <= k else (0.5 - u)
    return k / (2.0 * u) * math.exp(e * lnx)


def skewed(base: float, s: float, k: float) -> float:
    m = math.log(k / s)
    return base * (1.0 + K_PUT * max(0.0, -m) + K_CALL * max(0.0, m))


def value(s: float, k: float, is_call: bool, base_sigma: float, tau_s: float) -> tuple[float, float]:
    """(V, time value) of one unit at the skewed sigma."""
    tv = time_value(s, k, skewed(base_sigma, s, k), tau_s)
    payoff = max(s - k, 0.0) if is_call else max(k - s, 0.0)
    return payoff + tv, tv


def spread_per_unit(v: float, s: float, k: float, session: str) -> float:
    frac = min(abs(k / s - 1.0) / FAR_M, 1.0)
    bps = (SPREAD_ATM + (SPREAD_FAR - SPREAD_ATM) * frac) * SESSION_MULT[session]
    return max(v * bps, MIN_SPREAD)


def best_round_trip(path, s: float, k: float, is_call: bool, tau_s: float, buyable=lambda t, sess: sess != "CLOSED") -> float:
    """path = [(t_seconds, base_sigma, session)]. Buy one unit at step i (if buyable), sell at any later step j with the
    funding in between (rate = time value / V at the start of each step); returns the largest profit as a share of the
    price paid (negative = every pair loses)."""
    n = len(path)
    ts = np.array([p[0] for p in path], dtype=float)
    vt = [value(s, k, is_call, p[1], tau_s) for p in path]
    v = np.array([x[0] for x in vt])
    tv = np.array([x[1] for x in vt])
    spread = np.array([spread_per_unit(v[i], s, k, path[i][2]) for i in range(n)])
    r = np.where(v > 0, np.clip(tv / np.where(v > 0, v, 1.0), 0.0, 1.0), 1.0)
    cum = np.concatenate([[0.0], np.cumsum(r[:-1] * np.diff(ts) / tau_s)])  # funding exponent accrued up to step j
    bid = np.maximum(v - spread, 0.0)
    best = -1.0
    for i in range(n - 1):
        if not buyable(ts[i], path[i][2]):
            continue
        cost = v[i] + spread[i] + FEE * s
        norm = np.exp(-(cum[i + 1:] - cum[i]))
        proceeds = norm * (bid[i + 1:] - FEE * s)
        best = max(best, float(np.max((proceeds - cost) / cost)))
    return best


def best_drift(path, s: float, k: float, is_call: bool, tau_s: float, min_lag_s: float) -> float:
    """Largest value gain norm_j V_j / V_i - 1 over pairs at least `min_lag_s` apart, with no spread and no fee: the pure
    drift of the value against funding."""
    ts = np.array([p[0] for p in path], dtype=float)
    vt = [value(s, k, is_call, p[1], tau_s) for p in path]
    v = np.array([x[0] for x in vt])
    tv = np.array([x[1] for x in vt])
    r = np.where(v > 0, np.clip(tv / np.where(v > 0, v, 1.0), 0.0, 1.0), 1.0)
    cum = np.concatenate([[0.0], np.cumsum(r[:-1] * np.diff(ts) / tau_s)])
    best = -1.0
    for i in range(len(path) - 1):
        j = np.nonzero(ts >= ts[i] + min_lag_s)[0]
        if j.size == 0:
            break
        gain = np.exp(-(cum[j] - cum[i])) * v[j] / v[i] - 1.0
        best = max(best, float(np.max(gain)))
    return best
