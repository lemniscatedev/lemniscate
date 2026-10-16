"""End to end against a LOCAL anvil: deploy VolOracle, let the engine sign and send, read the posts back.

Skipped when anvil/cast or the compiled contract (contracts/out, built by `forge build`) are missing.
Nothing here touches a real network.
"""

import dataclasses
import json
import shutil
import socket
import subprocess
import time
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

import pytest

from vol_engine.bars import Tick
from vol_engine.config import Settings
from vol_engine.engine import run_cycle
from vol_engine.history import History
from vol_engine.sender import http_transport, make_sender, read_oracle_timers
from vol_engine.store import MemoryStore

from helpers import ANVIL_KEY, STOCKS, synthetic_ticks, weekdays

ROOT = Path(__file__).resolve().parents[2]
ARTIFACT = ROOT / "contracts" / "out" / "VolOracle.sol" / "VolOracle.json"
ANVIL = shutil.which("anvil") or str(Path.home() / ".foundry/bin/anvil")
CAST = shutil.which("cast") or str(Path.home() / ".foundry/bin/cast")
DEV0 = "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"

pytestmark = pytest.mark.skipif(
    not (ARTIFACT.exists() and Path(ANVIL).exists() and Path(CAST).exists()), reason="needs anvil, cast and forge build output"
)


def free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def cast(*args: str) -> str:
    return subprocess.run([CAST, *args], capture_output=True, text=True, check=True).stdout.strip()


@pytest.fixture()
def chain():
    port = free_port()
    proc = subprocess.Popen([ANVIL, "--port", str(port), "--chain-id", "31337", "--silent"])
    url = f"http://127.0.0.1:{port}"
    for _ in range(50):
        try:
            cast("block-number", "--rpc-url", url)
            break
        except subprocess.CalledProcessError:
            time.sleep(0.2)
    try:
        yield url
    finally:
        proc.terminate()
        proc.wait(timeout=10)


def test_engine_posts_are_accepted_by_the_real_contract(chain):
    code = json.loads(ARTIFACT.read_text())["bytecode"]["object"]
    args = cast("abi-encode", "constructor(address,address,uint64,uint64)", DEV0, DEV0, "7200", "300")
    out = cast("send", "--rpc-url", chain, "--private-key", ANVIL_KEY, "--create", code + args[2:], "--json")
    oracle = json.loads(out)["contractAddress"]

    now = datetime.now(timezone.utc)
    st = MemoryStore()
    ticks, _, _ = synthetic_ticks(weekdays(date(2026, 9, 14), 21), seed=5, bar_vol=0.0010)
    ticks.append(Tick(now.timestamp() - 30, ticks[-1].spot, "REGULAR", True))
    st.tick_rows[STOCKS["NVDA"]] = ticks
    st.stocks["NVDA"] = STOCKS["NVDA"]
    s = Settings(signer_key=ANVIL_KEY, sender_key=ANVIL_KEY, oracle_address=oracle, chain_id=31337, rpc_url=chain,
                 send=True, names=("NVDA",))
    sender = make_sender(s, http_transport(chain))

    plans = run_cycle(now, st, sender, s, History(), force=True)
    assert [i.status for i in st.intents] == ["sent", "sent"]
    for plan in plans:
        sigma = cast("call", "--rpc-url", chain, oracle, "read(address,uint8)((uint64,uint64,uint64,uint64,uint64,uint64,bool))",
                     STOCKS["NVDA"], str(plan.speed))
        assert str(plan.post.sigma_bps) in sigma
        assert cast("call", "--rpc-url", chain, oracle, "lastNonce(address,uint8)(uint64)", STOCKS["NVDA"], str(plan.speed)).split()[0] == "1"

    # The contract allows one post per stock and speed per 5 minutes: advance the chain clock past it, with a
    # matching `now` so validUntil is valid against block.timestamp.
    cast("rpc", "--rpc-url", chain, "evm_increaseTime", "301")
    cast("rpc", "--rpc-url", chain, "evm_mine")
    chain_now = datetime.fromtimestamp(int(cast("block", "--rpc-url", chain, "--field", "timestamp")), timezone.utc)
    plans2 = run_cycle(chain_now, st, sender, s, History(), force=True)
    assert len(plans2) == 2
    assert [i.status for i in st.intents] == ["sent"] * 4
    for plan in plans2:
        assert cast("call", "--rpc-url", chain, oracle, "lastNonce(address,uint8)(uint64)", STOCKS["NVDA"], str(plan.speed)).split()[0] == "2"

    # An immediate third cycle is skipped by the engine itself (no signing, no tx, no revert on chain).
    blk = cast("block-number", "--rpc-url", chain)
    assert run_cycle(chain_now + timedelta(seconds=5), st, sender, s, History(), force=True) == []
    assert [i.status for i in st.intents] == ["sent"] * 4
    assert cast("block-number", "--rpc-url", chain) == blk


def test_short_testnet_timers_are_read_from_the_contract(chain):
    """Todo 10 R8: a testnet oracle deployed with a 30 s rate limit; the engine reads the timers and posts again after
    31 s instead of 5 minutes."""
    code = json.loads(ARTIFACT.read_text())["bytecode"]["object"]
    args = cast("abi-encode", "constructor(address,address,uint64,uint64)", DEV0, DEV0, "1800", "30")
    out = cast("send", "--rpc-url", chain, "--private-key", ANVIL_KEY, "--create", code + args[2:], "--json")
    oracle = json.loads(out)["contractAddress"]
    timers = read_oracle_timers(oracle, http_transport(chain))
    assert timers == {"max_validity_s": 1800, "min_post_interval_s": 30, "rolling_window_s": 360}

    chain_now = datetime.fromtimestamp(int(cast("block", "--rpc-url", chain, "--field", "timestamp")), timezone.utc)
    st = MemoryStore()
    ticks, _, _ = synthetic_ticks(weekdays(date(2026, 9, 14), 21), seed=7, bar_vol=0.0010)
    ticks.append(Tick(chain_now.timestamp() - 30, ticks[-1].spot, "REGULAR", True))
    st.tick_rows[STOCKS["NVDA"]] = ticks
    st.stocks["NVDA"] = STOCKS["NVDA"]
    s = dataclasses.replace(
        Settings(signer_key=ANVIL_KEY, sender_key=ANVIL_KEY, oracle_address=oracle, chain_id=31337, rpc_url=chain,
                 send=True, names=("NVDA",)), **timers)
    sender = make_sender(s, http_transport(chain))
    assert len(run_cycle(chain_now, st, sender, s, History(), force=True)) == 2
    cast("rpc", "--rpc-url", chain, "evm_increaseTime", "31")
    cast("rpc", "--rpc-url", chain, "evm_mine")
    later = datetime.fromtimestamp(int(cast("block", "--rpc-url", chain, "--field", "timestamp")), timezone.utc)
    assert len(run_cycle(later, st, sender, s, History(), force=True)) == 2
    assert [i.status for i in st.intents] == ["sent"] * 4
