"""Optional JSON history that the live tables are too short to supply.

moves file:   {"NVDA": [0.051, -0.07, ...]}   1-day moves after past reports, oldest first
weekend file: {"NVDA": [0.012, ...]}          |Friday close to Monday open| moves, one per week
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path


def _load(path: str) -> dict[str, list[float]]:
    if not path:
        return {}
    raw = json.loads(Path(path).read_text())
    return {k.upper(): [float(x) for x in v] for k, v in raw.items()}


@dataclass
class History:
    moves: dict[str, list[float]] = field(default_factory=dict)
    weekend: dict[str, list[float]] = field(default_factory=dict)

    @staticmethod
    def from_files(moves_file: str = "", weekend_file: str = "") -> "History":
        return History(_load(moves_file), _load(weekend_file))
