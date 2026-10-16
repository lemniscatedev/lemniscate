import logging

from vol_engine.config import Settings
from vol_engine.logs import REDACTED, ScrubFilter, scrub

from helpers import ANVIL_KEY


def capture(secrets):
    logger = logging.getLogger("vol_engine.test")
    logger.handlers.clear()
    logger.propagate = False
    logger.setLevel(logging.DEBUG)
    lines: list[str] = []

    class H(logging.Handler):
        def emit(self, record):
            lines.append(self.format(record))

    h = H()
    h.addFilter(ScrubFilter(secrets))
    h.setFormatter(logging.Formatter("%(message)s"))
    logger.addHandler(h)
    return logger, lines


def test_logs_are_scrubbed_of_keys_in_every_form():
    logger, lines = capture([ANVIL_KEY])
    bare = ANVIL_KEY[2:]
    logger.info("signing with %s", ANVIL_KEY)
    logger.info("raw " + bare + " and upper " + bare.upper())
    logger.info("VOL_SIGNER_KEY=%s", "somethingelse123")
    logger.info("connecting postgres://user:hunter2@db:5432/x")
    try:
        raise ValueError("boom " + ANVIL_KEY)
    except ValueError:
        logger.exception("failed")
    out = "\n".join(lines)
    assert bare not in out and bare.upper() not in out
    assert "hunter2" not in out and "somethingelse123" not in out
    assert REDACTED in out


def test_digests_and_tx_hashes_stay_readable():
    h = "0x" + "ab" * 32
    assert scrub(f"tx {h}", [ANVIL_KEY]) == f"tx {h}"


def test_settings_repr_hides_secrets():
    s = Settings(signer_key=ANVIL_KEY, sender_key="0x" + "12" * 32, database_url="postgres://u:pw@h/db")
    text = repr(s) + str(s)
    assert ANVIL_KEY not in text and "pw@h" not in text and ("12" * 32) not in text
