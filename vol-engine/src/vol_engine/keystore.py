"""Signing keys from the environment: a raw key (development) or an encrypted keystore plus a password file.

  VOL_SIGNER_KEY                         hex private key, development only
  VOL_SIGNER_KEYSTORE                    path of a Web3 Secret Storage v3 file (what `cast wallet import` writes)
  VOL_SIGNER_KEYSTORE_PASSWORD_FILE      path of the file holding its password

The same three-variable pattern applies to VOL_SENDER. NODE_ENV=production accepts only the keystore form and refuses a
key or password file that other users can read. The key is decrypted with eth_account, held in memory only, and never
appears in an error message. The operator supplies the keystore files; nothing here creates or looks for a key elsewhere.
"""

from __future__ import annotations

import json
import os
import re
import unicodedata
from typing import Mapping

from eth_account import Account

_RAW = re.compile(r"^(0x)?[0-9a-fA-F]{64}$")


class KeyConfigError(RuntimeError):
    """A signer is misconfigured. Names variables and paths, never a key or a password."""


def _read(path: str, what: str, variable: str, production: bool) -> str:
    try:
        if production and os.stat(path).st_mode & 0o007:
            raise KeyConfigError(f"{variable}: {path} is readable by other users; chmod 0440 (or 0400) and chown it to the service group")
        with open(path, encoding="utf-8") as fh:
            return fh.read()
    except KeyConfigError:
        raise
    except OSError:
        raise KeyConfigError(f"{variable}: cannot read the {what} at {path}") from None


def load_key(raw_var: str, prefix: str, env: Mapping[str, str]) -> str:
    """The 0x-prefixed key for one signer, or "" when it is not configured."""
    raw = env.get(raw_var, "").strip()
    keystore = env.get(f"{prefix}_KEYSTORE", "").strip()
    pw_var = f"{prefix}_KEYSTORE_PASSWORD_FILE"
    pw_file = env.get(pw_var, "").strip()
    production = env.get("NODE_ENV", "").strip() == "production"
    if raw and keystore:
        raise KeyConfigError(f"set {raw_var} or {prefix}_KEYSTORE, not both")
    if raw:
        if production:
            raise KeyConfigError(f"{raw_var} is set but NODE_ENV=production only accepts a keystore: use {prefix}_KEYSTORE and {pw_var}")
        if not _RAW.match(raw):
            raise KeyConfigError(f"{raw_var} must be 32 bytes of hex")
        return raw if raw.startswith("0x") else "0x" + raw
    if not keystore:
        if pw_file:
            raise KeyConfigError(f"{pw_var} is set without {prefix}_KEYSTORE")
        return ""
    if not pw_file:
        raise KeyConfigError(f"{prefix}_KEYSTORE needs {pw_var}")
    password = _read(pw_file, "password file", pw_var, production).rstrip("\r\n")
    try:
        data = json.loads(_read(keystore, "keystore", f"{prefix}_KEYSTORE", production))
    except ValueError:
        raise KeyConfigError(f"{prefix}_KEYSTORE: not a valid keystore file") from None
    try:
        key = Account.decrypt(data, unicodedata.normalize("NFKD", password).encode("utf-8"))
    except ValueError:
        raise KeyConfigError(f"{prefix}_KEYSTORE: could not decrypt (wrong password file or damaged keystore)") from None
    except Exception:  # eth_keyfile raises assorted types for malformed files; none may echo the contents
        raise KeyConfigError(f"{prefix}_KEYSTORE: could not decrypt (wrong password file or damaged keystore)") from None
    if len(key) != 32:
        raise KeyConfigError(f"{prefix}_KEYSTORE: decrypted key is not 32 bytes")
    return "0x" + bytes(key).hex()
