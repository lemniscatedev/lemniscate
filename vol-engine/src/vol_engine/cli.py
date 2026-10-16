"""vol-engine post --once | --loop"""

from __future__ import annotations

import argparse
import dataclasses
import sys
import time
from datetime import datetime, timezone

from .config import Settings
from .engine import run_cycle
from .history import History
from .logs import configure_logging
from .sender import http_transport, make_sender, read_oracle_timers
from .keystore import KeyConfigError
from .store import PgStore


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="vol-engine")
    sub = parser.add_subparsers(dest="command", required=True)
    post = sub.add_parser("post", help="compute, sign and post sigma for every name and speed")
    mode = post.add_mutually_exclusive_group(required=True)
    mode.add_argument("--once", action="store_true", help="one pass, always posts")
    mode.add_argument("--loop", action="store_true", help="repeat; posts only on a real change or near expiry")
    post.add_argument("--interval", type=int, default=300, help="seconds between passes in --loop (default 300)")
    args = parser.parse_args(argv)

    try:
        settings = Settings.from_env()
    except KeyConfigError as exc:  # names variables and paths only, never a key or a password
        print(f"vol-engine: {exc}", file=sys.stderr)
        return 78
    log = configure_logging(settings.secrets())
    if not settings.database_url:
        log.error("DATABASE_URL is required")
        return 2
    if settings.rpc_url and settings.oracle_address:
        try:  # keepers and services read the timers from the contract (todo 10 R8)
            settings = dataclasses.replace(settings, **read_oracle_timers(settings.oracle_address, http_transport(settings.rpc_url)))
            log.info("oracle timers: interval=%ds window=%ds max_validity=%ds", settings.min_post_interval_s,
                     settings.rolling_window_s, settings.max_validity_s)
        except Exception:  # noqa: BLE001 (keep the configured values; the contract still enforces its own)
            log.warning("could not read the oracle timers, using the configured values")
    sender = make_sender(settings)
    log.info("starting: names=%s send=%s", ",".join(settings.names), "ON" if settings.send else "off (dry-run)")
    store = PgStore(settings.database_url)
    history = History.from_files(settings.moves_file, settings.weekend_file)
    try:
        while True:
            try:
                run_cycle(datetime.now(timezone.utc), store, sender, settings, history, force=args.once)
            except Exception:  # noqa: BLE001 (a bad pass must not kill the loop; --once reports it)
                if args.once:
                    raise
                log.exception("pass failed, retrying next interval")
            if args.once:
                return 0
            time.sleep(args.interval)
    except KeyboardInterrupt:
        return 0
    finally:
        store.close()


if __name__ == "__main__":
    sys.exit(main())
