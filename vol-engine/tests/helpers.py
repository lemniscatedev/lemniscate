from __future__ import annotations

from datetime import date, datetime, time, timedelta

import numpy as np

from vol_engine.bars import ET, Tick

ANVIL_KEY = "0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80"  # // test-key
# Fake Stock Token addresses for tests; real ones come from the database.
STOCKS = {"NVDA": "0x00000000000000000000000000000000000a0001", "TSLA": "0x00000000000000000000000000000000000a0002",
          "SPY": "0x00000000000000000000000000000000000a0003", "QQQ": "0x00000000000000000000000000000000000a0004"}
ORACLE = "0x00000000000000000000000000000000000F0106"


def et_ts(d: date, hh: int, mm: int) -> float:
    return datetime.combine(d, time(hh, mm), tzinfo=ET).timestamp()


def weekdays(start: date, n: int) -> list[date]:
    out, d = [], start
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d)
        d += timedelta(days=1)
    return out


def synthetic_ticks(days: list[date], seed: int = 1, bar_vol: float = 0.0006, gap_vol: float = 0.004,
                    start_px: float = 100.0, extended: bool = False) -> tuple[list[Tick], list[list[float]], list[float]]:
    """78 regular 5-minute ticks per day. Returns (ticks, per-day closes, per-day opens)."""
    rng = np.random.default_rng(seed)
    ticks: list[Tick] = []
    closes_by_day: list[list[float]] = []
    opens: list[float] = []
    px = start_px
    for d in days:
        px *= float(np.exp(rng.normal(0, gap_vol)))
        closes: list[float] = []
        t0 = et_ts(d, 9, 30)
        for i in range(78):
            if i > 0:
                px *= float(np.exp(rng.normal(0, bar_vol)))
            closes.append(px)
            ticks.append(Tick(t0 + 300 * i + 1, px, "REGULAR", True))
        opens.append(closes[0])
        closes_by_day.append(closes)
        if extended:
            for hh, mm in ((8, 0), (17, 0)):
                ticks.append(Tick(et_ts(d, hh, mm), px * 1.05, "EXTENDED", True))
    return ticks, closes_by_day, opens
