"""DEP-6: the vol engine started with the shipped env.example values is safe or refuses to start."""
import re
from pathlib import Path

import pytest

from vol_engine.config import Settings
from vol_engine.sender import DryRunSender, make_sender
from vol_engine.signer import Post, sign_post

from helpers import ANVIL_KEY

EXAMPLE = Path(__file__).resolve().parents[2] / "app" / "scripts" / "server" / "env.example"


def example_env() -> dict[str, str]:
    env = {}
    for line in EXAMPLE.read_text().splitlines():
        m = re.match(r"^([A-Z0-9_]+)=(.*)$", line)
        if m:
            env[m.group(1)] = m.group(2)
    return env


def test_example_does_not_enable_sending_or_carry_a_key():
    settings = Settings.from_env(example_env())
    assert settings.send is False
    assert settings.signer_key == "" and settings.sender_key == ""
    assert isinstance(make_sender(settings), DryRunSender)


def test_placeholder_oracle_address_cannot_sign():
    settings = Settings.from_env(example_env())
    assert settings.oracle_address == "CHANGE_ME"
    post = Post("0x" + "11" * 20, 0, 5000, 0, 0, 0, 0, 2_000_000_000, 1)
    with pytest.raises(Exception):
        sign_post(ANVIL_KEY, post, settings.chain_id, settings.oracle_address)


def test_example_points_at_the_mainnet_chain_and_two_hour_cap():
    settings = Settings.from_env(example_env())
    assert settings.chain_id == 4663
    assert settings.validity_s <= settings.max_validity_s
