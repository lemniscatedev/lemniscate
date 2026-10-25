"""Compute, guard, sign and (optionally) send one VolOracle post per name and speed."""

from __future__ import annotations

import logging
import math
from dataclasses import dataclass, field
from datetime import datetime, time, timedelta

from .bars import ET, EXTENDED, DayBars, build_regular_series, et_day
from .calendar import closed_run_elapsed_s
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
from .guard import ROLLING_WINDOW_S, clamp_step, next_allowed_at, window_bounds
from .history import History
from .realized import realized_vol
from .sender import Sender, SignedPost
from .signer import Post, sign_post
from .store import Intent, Store
from .surface import WEEKEND_DRIFT_SHARE, add_event_variance, earnings_move, earnings_weight, pack_skew_k, ramp_length_s, sigma_base, weekend_move

log = logging.getLogger("vol_engine")

LOOKBACK_DAYS = 45
ALERT_REPEAT_S = 6 * 3600
# F44: a broadcast post with no receipt after this long is treated as dropped.
PENDING_TTL_S = 15 * 60
# F43: the indexer snapshots at least every 10 minutes in production (INDEXER_SNAPSHOT_HEARTBEAT_MS, capped at 10 min; the
# fork profile uses 60 s so a warped clock does not pause names); ticks older than two heartbeats plus 5 minutes are a dead indexer.
MAX_TICK_AGE_S = 25 * 60
MIN_RELATIVE_CHANGE = 0.01
# F05: when the target sigma is further than this (relative) above what is posted, buys stay blocked until the ramp has caught up.
RAMP_BLOCK_REL = 0.02
WINDOW_QUANTUM_S = 900
FORCE_REUSE_S = 23 * 3600
STEP_UP = 1.25  # VolOracle: at most +25% per post
WINDOW_UP = 1.5  # VolOracle: at most x1.5 per rolling window


def ramp_duration_s(posted_bps: int, target_bps: int, min_post_interval_s: int, rolling_window_s: int) -> int:
    """How long the contract's step rules need to carry the posted sigma up to the target, plus one interval of slack."""
    if target_bps <= posted_bps or posted_bps <= 0:
        return 0
    ratio = target_bps / posted_bps
    by_step = math.ceil(math.log(ratio) / math.log(STEP_UP)) * min_post_interval_s
    by_window = math.ceil(math.log(ratio) / math.log(WINDOW_UP)) * rolling_window_s
    return max(by_step, by_window) + min_post_interval_s


def _active(prev: Intent | None, now_s: int) -> bool:
    return bool(prev and prev.buy_block_to and prev.buy_block_from <= now_s <= prev.buy_block_to)


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
              include_dry_run: bool, stocks: dict[str, str] | None = None, rolling_window_s: int | None = None,
              max_validity_s: int = MAX_VALIDITY_S, min_post_interval_s: int = 300) -> Plan | None:
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
    age = now_s - ticks[-1].ts
    if age > MAX_TICK_AGE_S:
        # F43: refuse to sign from a frozen snapshot. The last post then runs out, the oracle reports stale and the engine's
        # StaleVol pause blocks buys, instead of this process re-signing a dead sigma forever.
        log.error("newest tick for %s is %ds old (limit %ds): not signing", name, age, MAX_TICK_AGE_S)
        _record_alerts(store, name, [("stale_ticks", {"age_s": int(age // 600) * 600, "limit_s": MAX_TICK_AGE_S})], now_s)
        return None

    flags: list[str] = []
    series = build_regular_series(ticks)
    newest = ticks[-1]
    if newest.session == EXTENDED and newest.spot > 0.0 and series.days and et_day(newest.ts) > series.days[-1].day:
        # Pre-market print: the overnight gap is already visible, so it enters the estimate now instead of as a step at
        # the 09:30 open (F05c). A day with one point adds a gap and no intraday returns.
        series.days.append(DayBars(et_day(newest.ts), newest.spot, newest.spot, [newest.spot]))
        flags.append("extended_gap_provisional")
    prev = store.last_intent(stock, SPEED_NAMES[speed])
    rv = realized_vol(series, speed)
    flags += rv.flags
    base = sigma_base(rv.sigma, name)
    sigma = base

    # Earnings (R5, R7).
    block_from = block_to = 0
    decision = reconcile(name, store.earnings(name), now)
    if decision.force_block:
        block_from, block_to = decision.force_block
        if _active(prev, now_s) and prev.buy_block_to - now_s >= FORCE_REUSE_S:  # F45: keep the window, do not slide it
            block_from, block_to = prev.buy_block_from, prev.buy_block_to
        flags.append(f"earnings_{decision.status}")
    elif decision.status == "confirmed" and decision.report_date is not None:
        report_ts, lo, hi, day_end = report_times(decision.report_date, decision.session)
        if speed != WEEKLY:  # Daily speed: blocked the whole report day
            day_start = int(datetime.combine(decision.report_date, time(0, 0), tzinfo=ET).timestamp())
            lo, hi = min(lo, day_start), max(hi, day_end)
        e, e_flags = earnings_move(name, history.moves.get(name, []))
        length = ramp_length_s(sigma, e, tau)
        if hi >= now_s and report_ts - now_s <= length:
            w = earnings_weight(report_ts, now_s, sigma, e, tau)  # F05/R01: ramps in from 0, `length` before the report, value drift under funding
            flags += e_flags + ["earnings_bump"]
            sigma = add_event_variance(sigma, e, tau, w)
            block_from, block_to = lo, hi

    # Weekend (R6): the CLOSED run (Fri 20:00 ET to Sun 20:00 ET, longer around holidays) ramps in from its first second on
    # the same value-drift schedule as an earnings report (F05b, R01): only as far as funding allows within the run, so a
    # buyer from before the run cannot sell into it at a profit at any strike. A closure the calendar does not know is full
    # weight, as before (nobody can buy into it).
    elapsed = closed_run_elapsed_s(now)
    g, g_flags = weekend_move(name, history.weekend.get(name, []))
    weekend_w: float | None = None
    if elapsed is not None:
        weekend_w = earnings_weight(ramp_length_s(sigma, g, tau, WEEKEND_DRIFT_SHARE), elapsed, sigma, g, tau, WEEKEND_DRIFT_SHARE)
    elif newest.session == "CLOSED":
        weekend_w = 1.0
    if weekend_w:
        flags += g_flags + ["weekend_bump"]
        sigma = add_event_variance(sigma, g, tau, weekend_w)

    floor_bps = round(floor_for(name) * BPS)
    target = round(sigma * BPS)
    prior = store.reference(stock, SPEED_NAMES[speed], include_dry_run)
    window = window_bounds(store.recent_sent(stock, SPEED_NAMES[speed], now_s), now_s, floor_bps,
                           rolling_window_s or ROLLING_WINDOW_S)  # rolling bound (04b R7; 1h on mainnet)
    sigma_bps, ramped = clamp_step(target, prior, floor_bps, window)  # R8
    if ramped:
        flags.append(f"ramped:{target}->{sigma_bps}")
    if target > sigma_bps and (target - sigma_bps) > sigma_bps * RAMP_BLOCK_REL:
        # F05: the posted sigma lags a known higher value. Nobody may buy at the lagging value, so buys are blocked from
        # now until the contract's step rules have carried the post up to the target (window quantised, kept while active).
        end = now_s + ramp_duration_s(sigma_bps, target, min_post_interval_s, rolling_window_s or ROLLING_WINDOW_S)
        end = -(-end // WINDOW_QUANTUM_S) * WINDOW_QUANTUM_S
        if _active(prev, now_s):
            start = prev.buy_block_from
            end = max(end, prev.buy_block_to)  # an active window never shrinks while the ramp is still running
        else:
            start = now_s
        block_from = min(x for x in (block_from, start) if x) if block_from else start
        block_to = max(block_to, end)
        flags.append("buy_block_ramp")
    if block_to - block_from > MAX_BUY_BLOCK_S:  # the contract rejects longer windows
        block_to = block_from + MAX_BUY_BLOCK_S
        flags.append("buy_block_truncated")

    post = Post(
        stock=stock, speed=speed, sigma_bps=sigma_bps, skew_k=pack_skew_k(),
        event_bump_bps=max(0, round((sigma - base) * BPS)), buy_block_from=block_from, buy_block_to=block_to,
        valid_until=now_s + min(validity_s, max_validity_s - 60), nonce=store.max_nonce(stock, SPEED_NAMES[speed]) + 1,
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


def reconcile_pending(store: Store, sender: Sender, now_s: float) -> set[tuple[str, str]]:
    """F44: resolve posts that were broadcast without a receipt. Returns the (stock, speed) pairs still waiting, which
    are not re-planned this pass. Only a mined, successful post ever becomes 'sent' (and so a step reference)."""
    waiting: set[tuple[str, str]] = set()
    for i in store.pending_intents():
        verdict = sender.confirm(i.tx_hash or "")
        if verdict is not None:
            store.mark_intent(i.stock, i.speed, i.nonce, verdict, i.tx_hash)
            if verdict == "failed":
                _record_alerts(store, i.name, [("post_reverted", {"speed": i.speed, "nonce": i.nonce, "tx": i.tx_hash})], now_s)
        elif now_s - i.created_at > PENDING_TTL_S:
            store.mark_intent(i.stock, i.speed, i.nonce, "failed", i.tx_hash)
            _record_alerts(store, i.name, [("post_dropped", {"speed": i.speed, "nonce": i.nonce, "tx": i.tx_hash})], now_s)
        else:
            waiting.add((i.stock, i.speed))
    return waiting


def run_cycle(now: datetime, store: Store, sender: Sender, settings: Settings, history: History, force: bool) -> list[Plan]:
    """One pass over every configured name and both speeds. Returns the plans that were signed."""
    done: list[Plan] = []
    include_dry = not settings.send
    now_s = int(now.timestamp())
    waiting = reconcile_pending(store, sender, now_s) if settings.send else set()
    for name in settings.names:
        for speed in (0, 1):
            stock = dict(settings.stocks).get(name) or store.stock_token(name)
            if stock and (stock, SPEED_NAMES[speed]) in waiting:
                log.info("%s %s has a post waiting for its receipt, skipping", name, SPEED_NAMES[speed])
                continue
            plan = plan_post(name, speed, now, store, history, settings.validity_s, include_dry, dict(settings.stocks),
                             settings.rolling_window_s, settings.max_validity_s, settings.min_post_interval_s)
            if plan is None:
                continue
            _record_alerts(store, name, plan.alerts, now_s)
            speed_name = SPEED_NAMES[speed]
            nxt = next_allowed_at(store.recent_sent(plan.stock, speed_name, now_s), settings.min_post_interval_s)
            if now_s < nxt:  # the contract rejects (RateLimited) a second post inside the interval, even when forced
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
