"""Static parameters and environment settings.

Secrets come from the process environment (a raw key for development, or a keystore plus password file) and are excluded from every repr.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Mapping

from .keystore import load_key

BPS = 10_000
YEAR_SECONDS = 365 * 86_400
TRADING_DAYS = 252
BAR_SECONDS = 300
BARS_PER_DAY = 78  # 6.5 regular hours of 5-minute bars

# Speed codes follow the contract enum: DAILY = 0, WEEKLY = 1.
DAILY, WEEKLY = 0, 1
SPEED_NAMES = {DAILY: "DAILY", WEEKLY: "WEEKLY"}
TAU_SECONDS = {DAILY: 86_400, WEEKLY: 7 * 86_400}
# EWMA half-life: 1 day for Daily, 5 days for Weekly (spec section 3).
HALF_LIFE_DAYS = {DAILY: 1.0, WEEKLY: 5.0}

RV_MARKUP = 1.15
K_PUT = 1.2
K_CALL = 0.4

# Launch names. Stock Token addresses are not hardcoded: they come from `ticks` (name -> stock_token) or VOL_STOCKS.
LAUNCH_NAMES: tuple[str, ...] = ("NVDA", "TSLA", "SPY", "QQQ", "AAPL")
# Names that never report earnings.
NO_EARNINGS = frozenset({"SPY", "QQQ"})

# Floors (spec: 30% mega-caps, 45% others). Configurable list.
MEGA_CAPS = frozenset({"NVDA", "TSLA", "SPY", "QQQ", "AAPL"})
FLOOR_MEGA = 0.30
FLOOR_OTHER = 0.45

# Conservative defaults used (and flagged) when history is too short.
EARNINGS_MOVE_DEFAULT = {"default": 0.06, "TSLA": 0.08, "NVDA": 0.07}
WEEKEND_GAP_DEFAULT = {"default": 0.04, "SPY": 0.02, "QQQ": 0.025}
MIN_EARNINGS_MOVES = 4
EARNINGS_MOVES_USED = 8
MIN_WEEKEND_SAMPLES = 26

# Oracle guards mirrored from VolOracle.sol.
MAX_STEP_BPS = 2_500
MAX_VALIDITY_S = 7_200
MAX_BUY_BLOCK_S = 3 * 86_400
DEFAULT_ORACLE_FLOOR_BPS = 3_000


def floor_for(name: str, mega_caps: frozenset[str] = MEGA_CAPS) -> float:
    return FLOOR_MEGA if name.upper() in mega_caps else FLOOR_OTHER


@dataclass(frozen=True)
class Settings:
    database_url: str = field(default="", repr=False)
    signer_key: str = field(default="", repr=False)
    sender_key: str = field(default="", repr=False)
    oracle_address: str = ""
    chain_id: int = 4663
    rpc_url: str = ""
    send: bool = False
    moves_file: str = ""
    weekend_file: str = ""
    validity_s: int = 3_600
    # VolOracle timers (deploy-time on chain since todo 10 R8: minutes on testnet). Mainnet defaults here; the CLI
    # replaces them with the deployed oracle's own values when an RPC and the oracle address are configured.
    min_post_interval_s: int = 300
    rolling_window_s: int = 3_600
    max_validity_s: int = MAX_VALIDITY_S
    names: tuple[str, ...] = LAUNCH_NAMES
    stocks: tuple[tuple[str, str], ...] = ()  # optional (name, address) overrides from VOL_STOCKS
    # "wall" (default) or "chain": take "now" from the latest block (an anvil fork moved with evm_increaseTime).
    clock: str = "wall"

    @staticmethod
    def from_env(env: Mapping[str, str] | None = None) -> "Settings":
        e = os.environ if env is None else env
        names = tuple(n.strip().upper() for n in e.get("VOL_NAMES", "").split(",") if n.strip()) or LAUNCH_NAMES
        return Settings(
            database_url=e.get("DATABASE_URL", ""),
            signer_key=load_key("VOL_SIGNER_KEY", "VOL_SIGNER", e),
            sender_key=load_key("VOL_SENDER_KEY", "VOL_SENDER", e),
            oracle_address=e.get("VOL_ORACLE_ADDRESS", ""),
            chain_id=int(e.get("VOL_CHAIN_ID", "4663")),
            rpc_url=e.get("VOL_RPC_URL", ""),
            send=e.get("VOL_SEND", "0") == "1",  # only the exact string "1" turns sending on
            moves_file=e.get("VOL_MOVES_FILE", ""),
            weekend_file=e.get("VOL_WEEKEND_FILE", ""),
            validity_s=int(e.get("VOL_VALIDITY_S", "3600")),
            min_post_interval_s=int(e.get("VOL_MIN_POST_INTERVAL_S", "300")),
            rolling_window_s=int(e.get("VOL_ROLLING_WINDOW_S", "3600")),
            max_validity_s=int(e.get("VOL_MAX_VALIDITY_S", str(MAX_VALIDITY_S))),
            names=names,
            clock="chain" if e.get("VOL_CLOCK", "wall").strip().lower() == "chain" else "wall",
            stocks=tuple(
                (k.strip().upper(), v.strip().lower())
                for k, _, v in (item.partition("=") for item in e.get("VOL_STOCKS", "").split(",") if item.strip())
            ),
        )

    def secrets(self) -> list[str]:
        return [s for s in (self.signer_key, self.sender_key) if s]
