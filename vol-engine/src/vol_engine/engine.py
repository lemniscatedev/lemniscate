"""Compute, guard, sign and (optionally) send one VolOracle post per name and speed."""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta

from .bars import ET, build_regular_series
from .config import (
    BPS,
    MAX_BUY_BLOCK_S,
    MAX_VALIDITY_S,
    SPEED_NAMES,
    TAU_SECONDS,
    WEEKLY,
    Settings,
    floor_for,
)
from .earnings import reconcile, report_times
from .guard import clamp_step, next_allowed_at, window_bounds
from .history import History
from .realized import realized_vol
from .sender import Sender, SignedPost
from .signer import Post, sign_post
from .store import Intent, Store
from .surface import add_event_variance, earnings_move, pack_skew_k, sigma_base, weekend_move

log = logging.getLogger("vol_engine")

LOOKBACK_DAYS = 45
ALERT_REPEAT_S = 6 * 3600
MIN_RELATIVE_CHANGE = 0.01


@dataclass
class Plan:
    name: str
    stock: str
    speed: int
    post: Post
    target_bps: int
    ramped: bool
    sigma_rv: float
    sigma_base: float
    flags: list[str] = field(default_factory=list)
    alerts: list[tuple[str, dict]] = field(default_factory=list)


def plan_post(name: str, speed: int, now: datetime, store: Store, history: History, validity_s: int,
              include_dry_run: bool, stocks: dict[str, str] | None = None) -> Plan | None:
    stocks = stocks or {}
    stock = stocks.get(name) or store.stock_token(name)
    if not stock:
        log.warning("no stock token known for %s, skipping", name)
        return None
    tau = TAU_SECONDS[speed]
    now_s = int(now.timestamp())
    ticks = store.ticks(stock, now_s - LOOKBACK_DAYS * 86_400)
    if not ticks:
        log.warning("no ticks for %s, skipping", name)
        return None

    flags: list[str] = []
    series = build_regular_series(ticks)
    rv = realized_vol(series, speed)
    flags += rv.flags
    base = sigma_base(rv.sigma, name)
    sigma = base

    # Earnings (R5, R7).
    block_from = block_to = 0
    decision = reconcile(name, store.earnings(name), now)
    if decision.force_block:
        block_from, block_to = decision.force_block
        flags.append(f"earnings_{decision.status}")
    elif decision.status == "confirmed" and decision.report_date is not None:
        report_ts, lo, hi, day_end = report_times(decision.report_date, decision.session)
        if speed != WEEKLY:  # Daily speed: blocked the whole report day
            day_start = int(datetime.combine(decision.report_date, time(0, 0), tzinfo=ET).timestamp())
            lo, hi = min(lo, day_start), max(hi, day_end)
        if hi >= now_s and report_ts - now_s <= 2 * tau:
            e, e_flags = earnings_move(name, history.moves.get(name, []))
            flags += e_flags + ["earnings_bump"]
            sigma = add_event_variance(sigma, e, tau)
            block_from, block_to = lo, hi
    if block_to - block_from > MAX_BUY_BLOCK_S:  # the contract rejects longer windows
        block_to = block_from + MAX_BUY_BLOCK_S
        flags.append("buy_block_truncated")

    # Weekend (R6): the next session is CLOSED.
    if ticks[-1].session == "CLOSED":
        g, g_flags = weekend_move(name, history.weekend.get(name, []))
        flags += g_flags + ["weekend_bump"]
        sigma = add_event_variance(sigma, g, tau)

    floor_bps = round(floor_for(name) * BPS)
    target = round(sigma * BPS)
    prior = store.reference(stock, SPEED_NAMES[speed], include_dry_run)
    window = window_bounds(store.recent_sent(stock, SPEED_NAMES[speed], now_s), now_s, floor_bps)  # 1h bound (04b R7)
    sigma_bps, ramped = clamp_step(target, prior, floor_bps, window)  # R8
    if ramped:
        flags.append(f"ramped:{target}->{sigma_bps}")

    post = Post(
        stock=stock, speed=speed, sigma_bps=sigma_bps, skew_k=pack_skew_k(),
        event_bump_bps=max(0, round((sigma - base) * BPS)), buy_block_from=block_from, buy_block_to=block_to,
        valid_until=now_s + min(validity_s, MAX_VALIDITY_S - 60), nonce=store.max_nonce(stock, SPEED_NAMES[speed]) + 1,
    )
    return Plan(name, stock, speed, post, target, ramped, rv.sigma, base, flags, decision.alerts)


def worth_posting(plan: Plan, last: Intent | None, validity_s: int, now_s: int) -> bool:
    """Loop mode only posts on a real change or when the last post is about to expire."""
    if last is None:
        return True
    p = plan.post
    if abs(p.sigma_bps - last.sigma_bps) / max(last.sigma_bps, 1) >= MIN_RELATIVE_CHANGE:
        return True
    if (p.buy_block_from, p.buy_block_to, p.event_bump_bps > 0) != (last.buy_block_from, last.buy_block_to, last.event_bump_bps > 0):
        return True
    return last.valid_until - now_s < validity_s / 3


def _record_alerts(store: Store, name: str, alerts: list[tuple[str, dict]], now_s: float) -> None:
    for kind, detail in alerts:
        prev = store.last_alert(name, kind)
        if prev and prev[1] == detail and now_s - prev[0] < ALERT_REPEAT_S:
            continue
        store.write_alert(name, kind, detail, now_s)
        log.warning("alert %s %s %s", name, kind, detail)


def run_cycle(now: datetime, store: Store, sender: Sender, settings: Settings, history: History, force: bool) -> list[Plan]:
    """One pass over every configured name and both speeds. Returns the plans that were signed."""
    done: list[Plan] = []
    include_dry = not settings.send
    now_s = int(now.timestamp())
    for name in settings.names:
        for speed in (0, 1):
            plan = plan_post(name, speed, now, store, history, settings.validity_s, include_dry, dict(settings.stocks))
            if plan is None:
                continue
            _record_alerts(store, name, plan.alerts, now_s)
            speed_name = SPEED_NAMES[speed]
            nxt = next_allowed_at(store.recent_sent(plan.stock, speed_name, now_s))
            if now_s < nxt:  # the contract rejects (RateLimited) a second post inside 5 min, even when forced
                log.info("%s %s rate-limited until %d, skipping", name, speed_name, nxt)
                continue
            if not force and not worth_posting(plan, store.last_intent(plan.stock, speed_name), settings.validity_s, now_s):
                continue
            if not settings.signer_key or not settings.oracle_address:
                raise RuntimeError("VOL_SIGNER_KEY and VOL_ORACLE_ADDRESS are required to sign")
            dig, sig = sign_post(settings.signer_key, plan.post, settings.chain_id, settings.oracle_address)
            p = plan.post
            intent = Intent(
                stock=plan.stock, name=name, speed=speed_name, sigma_bps=p.sigma_bps, skew_k=p.skew_k,
                event_bump_bps=p.event_bump_bps, buy_block_from=p.buy_block_from, buy_block_to=p.buy_block_to,
                valid_until=p.valid_until, nonce=p.nonce, digest="0x" + dig.hex(), sig="0x" + sig.hex(),
                status="dry_run" if not settings.send else "pending", flags=plan.flags, created_at=float(now_s),
            )
            store.write_intent(intent)
            result = sender.send(SignedPost(p, dig, sig))
            if settings.send:
                store.mark_intent(plan.stock, speed_name, p.nonce, result.status, result.tx_hash)
                if result.status == "failed":
                    _record_alerts(store, name, [("send_failed", {"speed": speed_name, "error": result.error})], now_s)
            log.info("%s %s sigma=%d bps (target %d) nonce=%d %s flags=%s", name, speed_name, p.sigma_bps, plan.target_bps,
                     p.nonce, result.status, ",".join(plan.flags) or "-")
            done.append(plan)
    return done
