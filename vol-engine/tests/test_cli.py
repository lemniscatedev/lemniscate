import pytest

from vol_engine.cli import main


def test_cli_requires_a_mode(capsys):
    with pytest.raises(SystemExit):
        main(["post"])


def test_cli_needs_database_url(monkeypatch):
    monkeypatch.delenv("DATABASE_URL", raising=False)
    assert main(["post", "--once"]) == 2
