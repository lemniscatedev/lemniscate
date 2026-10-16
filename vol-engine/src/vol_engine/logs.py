"""Logging that cannot leak secrets (R10).

Every record passes through ScrubFilter: configured secret values (with and without 0x), `key=`, `secret=`,
`password=` style assignments, and the password part of connection URLs are replaced before any handler sees them.
"""

from __future__ import annotations

import logging
import re
import sys
from typing import Iterable

REDACTED = "[redacted]"
_ASSIGN = re.compile(r"(?i)\b([a-z_]*(?:private_?key|secret|password|signer_?key|sender_?key|api_?key))\b(\s*[=:]\s*)(\S+)")
_URL_PASSWORD = re.compile(r"(?i)\b([a-z][a-z0-9+.-]*://[^\s:/@]+:)([^\s@/]+)(@)")


def scrub(text: str, secrets: Iterable[str] = ()) -> str:
    out = text
    for s in secrets:
        if not s:
            continue
        bare = s.removeprefix("0x")
        if len(bare) >= 8:  # case-insensitive, with or without the 0x prefix
            out = re.sub("(?i)(0x)?" + re.escape(bare), REDACTED, out)
    out = _URL_PASSWORD.sub(lambda m: m.group(1) + REDACTED + m.group(3), out)
    out = _ASSIGN.sub(lambda m: m.group(1) + m.group(2) + REDACTED, out)
    return out


class ScrubFilter(logging.Filter):
    def __init__(self, secrets: Iterable[str] = ()) -> None:
        super().__init__()
        self._secrets = [s for s in secrets if s]

    def filter(self, record: logging.LogRecord) -> bool:
        message = record.getMessage()
        record.msg = scrub(message, self._secrets)
        record.args = ()
        if record.exc_info:
            record.exc_text = scrub(logging.Formatter().formatException(record.exc_info), self._secrets)
            record.exc_info = None
        return True


def configure_logging(secrets: Iterable[str] = (), level: int = logging.INFO) -> logging.Logger:
    logger = logging.getLogger("vol_engine")
    logger.handlers.clear()
    handler = logging.StreamHandler(sys.stderr)
    handler.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    handler.addFilter(ScrubFilter(secrets))
    logger.addHandler(handler)
    logger.setLevel(level)
    logger.propagate = False
    return logger
