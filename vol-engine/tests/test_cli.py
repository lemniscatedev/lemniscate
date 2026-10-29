import pytest

from vol_engine.cli import main


def test_cli_requires_a_mode(capsys):
    with pytest.raises(SystemExit):
        main(["post"])


def test_cli_needs_database_url(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert main(["post", "--once"]) == 2


def test_chain_clock_uses_the_latest_block_time_on_a_warped_fork():
    """todo 23: on an anvil fork moved forward with evm_increaseTime, wall-clock posts carry a validUntil in the chain's
    past and VolOracle rejects every one (Expired). VOL_CLOCK=chain takes "now" from the latest block instead."""
    from datetime import datetime, timezone
    from vol_engine.cli import cycle_now
    from vol_engine.config import Settings

    calls = []

    def transport(method, params):
        calls.append((method, params))
        return {"timestamp": hex(1_800_000_000)}

    chain = Settings.from_env({"VOL_CLOCK": "chain"})
    assert chain.clock == "chain"
    assert cycle_now(chain, transport) == datetime.fromtimestamp(1_800_000_000, timezone.utc)
    assert calls == [("eth_getBlockByNumber", ["latest", False])]
    wall = Settings.from_env({})
    assert wall.clock == "wall"
    # Bracket the call between two readings of the clock instead of allowing a number of seconds of slack: the result
    # must be a wall-clock reading taken during the call, however slow the machine is.
    before = datetime.now(timezone.utc)
    got = cycle_now(wall, transport)
    after = datetime.now(timezone.utc)
    assert before <= got <= after
    assert len(calls) == 1
