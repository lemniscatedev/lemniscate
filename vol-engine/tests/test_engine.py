import json
from datetime import date, datetime, timedelta, timezone

import pytest

from vol_engine.bars import ET, Tick
from vol_engine.config import Settings
from vol_engine.earnings import SOURCE_A, SOURCE_B, EarningsRow, report_times
from vol_engine.engine import plan_post, run_cycle
from vol_engine.guard import clamp_step, next_allowed_at, window_bounds
from vol_engine.history import History
from vol_engine.sender import (
    POST_SELECTOR, DryRunSender, SendResult, RpcSender, SignedPost, encode_post_call, make_sender,
)
from vol_engine.signer import recover, sign_post
from vol_engine.store import MemoryStore

from helpers import ANVIL_KEY, ORACLE, STOCKS, et_ts, synthetic_ticks, weekdays

SPEED = {0: 'DAILY', 1: 'WEEKLY'}
NVDA = STOCKS["NVDA"]
# Tuesday 2026-10-13 18:00 UTC = 14:00 ET, inside a regular session.
NOW = datetime(2026, 10, 13, 18, 0, tzinfo=timezone.utc)


def store_with_ticks(names=("NVDA",), seed=1, bar_vol=0.0006):
    st = MemoryStore()
    days = weekdays(date(2026, 9, 14), 21)  # up to Mon 10-12
    for i, n in enumerate(names):
        ticks, _, _ = synthetic_ticks(days, seed=seed + i, bar_vol=bar_vol)
        ticks.append(Tick(NOW.timestamp() - 60, ticks[-1].spot, "REGULAR", True))
        st.tick_rows[STOCKS[n]] = ticks
        st.stocks[n] = STOCKS[n]
    return st


def settings(**kw):
    base = dict(signer_key=ANVIL_KEY, oracle_address=ORACLE, chain_id=31337, names=("NVDA",))
    base.update(kw)
    return Settings(**base)


def test_plan_uses_floor_when_realized_vol_is_low():
    st = store_with_ticks(bar_vol=0.0001)
    plan = plan_post("NVDA", 0, NOW, st, History(), 3600, True)
    assert plan.post.sigma_bps == 3000 and plan.post.event_bump_bps == 0
    assert plan.post.buy_block_from == plan.post.buy_block_to == 0
    assert plan.post.nonce == 1 and plan.post.valid_until == int(NOW.timestamp()) + 3600


def test_plan_high_realized_vol_is_above_floor_and_markup_applied():
    st = store_with_ticks(bar_vol=0.0030)
    plan = plan_post("NVDA", 0, NOW, st, History(), 3600, True)
    assert plan.sigma_rv > 0.3 and abs(plan.sigma_base - plan.sigma_rv * 1.15) < 1e-12
    assert plan.post.sigma_bps == round(plan.sigma_base * 10_000)


def test_earnings_bump_and_block_window_for_both_speeds():
    st = store_with_ticks(bar_vol=0.0001)
    st.earnings_rows = [EarningsRow("NVDA", date(2026, 10, 14), "post", SOURCE_A),
                        EarningsRow("NVDA", date(2026, 10, 14), "post", SOURCE_B)]
    h = History(moves={"NVDA": [0.05, -0.08, 0.06, 0.07, 0.04, 0.09, 0.05, 0.06]})
    daily = plan_post("NVDA", 0, NOW, st, h, 3600, True)
    weekly = plan_post("NVDA", 1, NOW, st, h, 3600, True)
    rep, lo, hi, day_end = report_times(date(2026, 10, 14), "post")
    # Daily: the whole ET report day is blocked. Weekly: 60 min before to 30 min after.
    assert daily.post.buy_block_from == int(datetime(2026, 10, 14, tzinfo=ET).timestamp())
    assert daily.post.buy_block_to == day_end
    assert (weekly.post.buy_block_from, weekly.post.buy_block_to) == (lo, hi)
    assert daily.post.event_bump_bps > 0 and weekly.post.event_bump_bps > 0
    # Daily bump (tau = 1d) is larger than weekly (tau = 7d) for the same move; both capped by the first-post floor rule only.
    assert daily.post.sigma_bps > weekly.post.sigma_bps
    assert "earnings_bump" in daily.flags


def test_report_outside_2tau_adds_nothing():
    st = store_with_ticks(bar_vol=0.0001)
    st.earnings_rows = [EarningsRow("NVDA", date(2026, 10, 20), "post", s) for s in (SOURCE_A, SOURCE_B)]
    daily = plan_post("NVDA", 0, NOW, st, History(), 3600, True)
    weekly = plan_post("NVDA", 1, NOW, st, History(), 3600, True)
    assert daily.post.event_bump_bps == 0 and daily.post.buy_block_to == 0
    assert weekly.post.event_bump_bps > 0  # 7 days is inside 2 * 7 days


def test_disagreeing_sources_block_buys_for_24h():
    st = store_with_ticks(bar_vol=0.0001)
    st.earnings_rows = [EarningsRow("NVDA", date(2026, 10, 20), "post", SOURCE_A),
                        EarningsRow("NVDA", date(2026, 10, 27), "post", SOURCE_B)]
    plan = plan_post("NVDA", 0, NOW, st, History(), 3600, True)
    assert (plan.post.buy_block_from, plan.post.buy_block_to) == (int(NOW.timestamp()), int(NOW.timestamp()) + 86_400)
    assert plan.post.event_bump_bps == 0
    assert plan.alerts and plan.alerts[0][0] == "earnings_sources_disagree"


def test_weekend_bump_when_session_closed():
    st = store_with_ticks(bar_vol=0.0001)
    last = st.tick_rows[NVDA][-1]
    st.tick_rows[NVDA].append(Tick(NOW.timestamp(), last.spot, "CLOSED", True))
    plan = plan_post("NVDA", 0, NOW, st, History(), 3600, True)
    assert "weekend_bump" in plan.flags and "weekend_move_default" in plan.flags
    assert plan.post.event_bump_bps > 0
    seeded = History(weekend={"NVDA": [0.02] * 30})
    plan2 = plan_post("NVDA", 0, NOW, st, seeded, 3600, True)
    assert "weekend_move_default" not in plan2.flags


def test_step_guard_ramps_and_nonce_increases_across_cycles():
    st = store_with_ticks(bar_vol=0.0001)
    st.earnings_rows = [EarningsRow("NVDA", date(2026, 10, 14), "post", s) for s in (SOURCE_A, SOURCE_B)]
    s = settings()
    seen = []
    for k in range(3):
        plans = run_cycle(NOW + timedelta(minutes=k), st, DryRunSender(), s, History(), force=True)
        seen.append([p for p in plans if p.speed == 0][0])
    # Cycle 1 has no prior: it posts the full target. Later cycles move at most 25% from the previous post.
    first = seen[0].post.sigma_bps
    assert seen[1].post.nonce == seen[0].post.nonce + 1
    assert abs(seen[1].post.sigma_bps - first) * 4 <= first
    # Now make the target far away by clearing the earnings: it must ramp down and say so.
    st.earnings_rows = []
    plan = run_cycle(NOW + timedelta(minutes=5), st, DryRunSender(), s, History(), force=True)
    down = [p for p in plan if p.speed == 0][0]
    assert down.post.sigma_bps >= 3000 and down.ramped == (down.post.sigma_bps != down.target_bps)


def test_postingLoop_dry_run_writes_signed_intent_rows_and_never_sends():
    st = store_with_ticks(("NVDA", "TSLA"))
    s = settings(names=("NVDA", "TSLA"))
    assert s.send is False
    plans = run_cycle(NOW, st, make_sender(s), s, History(), force=True)
    assert len(plans) == 4 and len(st.intents) == 4
    for i in st.intents:
        assert i.status == "dry_run" and i.tx_hash is None
        p = [pl for pl in plans if pl.stock == i.stock and pl.post.nonce == i.nonce and SPEED[pl.speed] == i.speed][0]
        dig, sig = sign_post(ANVIL_KEY, p.post, 31337, ORACLE)
        assert i.digest == "0x" + dig.hex() and i.sig == "0x" + sig.hex()
        assert recover(dig, sig) == "0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266"


def test_postingLoop_loop_mode_only_reposts_on_change_or_near_expiry():
    st = store_with_ticks()
    s = settings()
    assert len(run_cycle(NOW, st, DryRunSender(), s, History(), force=False)) == 2
    assert run_cycle(NOW + timedelta(minutes=5), st, DryRunSender(), s, History(), force=False) == []
    # 45 minutes later less than a third of the validity is left: it refreshes (the indexer is still writing ticks).
    st.tick_rows[NVDA].append(Tick((NOW + timedelta(minutes=45)).timestamp() - 30, st.tick_rows[NVDA][-1].spot, "REGULAR", True))
    later = run_cycle(NOW + timedelta(minutes=45), st, DryRunSender(), s, History(), force=False)
    assert len(later) == 2


def test_no_ticks_means_no_post():
    st = MemoryStore()
    assert run_cycle(NOW, st, DryRunSender(), settings(), History(), force=True) == []
    assert st.intents == []


def test_alerts_are_deduplicated():
    st = store_with_ticks(bar_vol=0.0001)
    st.earnings_rows = [EarningsRow("NVDA", date(2026, 10, 20), "post", SOURCE_A)]
    s = settings()
    run_cycle(NOW, st, DryRunSender(), s, History(), force=True)
    n = len(st.alerts)
    assert n >= 1
    run_cycle(NOW + timedelta(minutes=5), st, DryRunSender(), s, History(), force=True)
    assert len(st.alerts) == n


# ---- sending is gated -----------------------------------------------------------------------------------------


def test_VOL_SEND_defaults_off_and_only_exact_1_enables():
    assert Settings.from_env({}).send is False
    for v in ("", "0", "true", "yes", "11", " 1"):
        assert Settings.from_env({"VOL_SEND": v}).send is False
    assert Settings.from_env({"VOL_SEND": "1"}).send is True
    assert isinstance(make_sender(Settings.from_env({})), DryRunSender)


def test_RpcSender_refuses_without_the_flag_and_make_sender_needs_config():
    with pytest.raises(RuntimeError):
        RpcSender(ORACLE, 31337, ANVIL_KEY, lambda m, p: None)
    with pytest.raises(RuntimeError):
        make_sender(Settings(send=True))


def test_RpcSender_encodes_post_and_submits_via_transport():
    st = store_with_ticks()
    s = settings(send=True, rpc_url="http://unused", sender_key=ANVIL_KEY)
    calls = []

    def transport(method, params):
        calls.append(method)
        return {"eth_getTransactionCount": "0x5", "eth_gasPrice": "0x3b9aca00", "eth_estimateGas": "0x30d40",
                "eth_sendRawTransaction": "0x" + "ab" * 32, "eth_getTransactionReceipt": {"status": "0x1"}}[method]

    sender = make_sender(s, transport)
    plans = run_cycle(NOW, st, sender, s, History(), force=True)
    assert calls.count("eth_sendRawTransaction") == 2 and len(plans) == 2
    assert all(i.status == "sent" and i.tx_hash == "0x" + "ab" * 32 for i in st.intents)
    data = encode_post_call(SignedPost(plans[0].post, b"\0" * 32, b"\1" * 65))
    assert data[:4] == POST_SELECTOR and len(data) == 4 + 32 * 9 + 32 + 32 + 96


def test_failed_send_is_recorded_and_alerted():
    st = store_with_ticks()
    s = settings(send=True, rpc_url="http://unused")

    def boom(method, params):
        raise RuntimeError("node down")

    run_cycle(NOW, st, make_sender(s, boom), s, History(), force=True)
    assert {i.status for i in st.intents} == {"failed"}
    assert any(k == "send_failed" for _, _, k, _ in st.alerts)


def test_missing_signer_key_refuses_to_post():
    st = store_with_ticks()
    with pytest.raises(RuntimeError):
        run_cycle(NOW, st, DryRunSender(), settings(signer_key=""), History(), force=True)


def test_history_files(tmp_path):
    f = tmp_path / "m.json"
    f.write_text(json.dumps({"nvda": [0.05, 0.06]}))
    assert History.from_files(str(f)).moves == {"NVDA": [0.05, 0.06]}


def test_calldata_matches_cast():
    import pathlib
    import shutil
    import subprocess

    cast = shutil.which("cast") or str(pathlib.Path.home() / ".foundry/bin/cast")
    if not pathlib.Path(cast).exists():
        pytest.skip("cast not installed")
    v = json.loads((pathlib.Path(__file__).resolve().parents[2] / "contracts/test/vectors/volpost-eip712.json").read_text())
    m = v["typedData"]["message"]
    from vol_engine.signer import Post

    post = Post(m["stock"], m["speed"], m["sigmaBps"], m["skewK"], m["eventBumpBps"], m["buyBlockFrom"], m["buyBlockTo"], m["validUntil"], m["nonce"])
    data = encode_post_call(SignedPost(post, b"\0" * 32, bytes.fromhex(v["signature"][2:])))
    tup = "(%s,%d,%d,%d,%d,%d,%d,%d,%d)" % (m["stock"], m["speed"], m["sigmaBps"], m["skewK"], m["eventBumpBps"], m["buyBlockFrom"], m["buyBlockTo"], m["validUntil"], m["nonce"])
    want = subprocess.run(
        [cast, "calldata", "post((address,uint8,uint64,uint64,uint64,uint64,uint64,uint64,uint64),bytes)", tup, v["signature"]],
        capture_output=True, text=True, check=True,
    ).stdout.strip()
    assert "0x" + data.hex() == want


class SentSender:
    """Pretends the chain accepted every post."""

    def send(self, signed):
        return SendResult("sent", "0x" + "cd" * 32)


def test_window_bounds_mirror_the_contract():
    assert window_bounds([], 10_000, 3000) is None
    # Values are lifted to the floor; hi = floor(min*1.5), lo = ceil(max*0.5).
    assert window_bounds([(9_900, 4001), (9_000, 3501)], 10_000, 3000) == (2001, 5251)
    assert window_bounds([(9_900, 2000)], 10_000, 3000) == (1500, 4500)  # 2000 lifted to the 3000 floor
    # Entries older than the window drop out, except the newest one at or before the start (in force when it opened).
    # now=10_600 -> start=7_000: 8_000 is inside, 6_000 is the anchor, 1_000 is ignored.
    assert window_bounds([(8_000, 4000), (6_000, 9000), (1_000, 100)], 10_600, 3000) == (4500, 6000)
    assert window_bounds([(9_000, 6000), (1_000, 3000)], 13_599, 3000) == (3000, 9000)  # only the anchor counts
    assert next_allowed_at([(1_000, 4000)]) == 1_300 and next_allowed_at([]) == 0
    # Testnet oracles are deployed with short timers (todo 10 R8): the guard takes the live values.
    assert next_allowed_at([(1_000, 4000)], 30) == 1_030
    sent = [(9_000, 6000), (8_700, 4000), (1_000, 3000)]
    assert window_bounds(sent, 9_100, 3000, 360) == (3000, 6000)  # 6-minute window: 3000 is no longer in force
    assert window_bounds(sent, 9_100, 3000) == (3000, 4500)  # one-hour window


def test_window_clamp_stops_a_sequence_that_would_breach_the_hour_bound():
    floor = 3000
    sent = [(0.0, 3000)]
    t = 0.0
    values = [3000]
    for _ in range(4):  # the target keeps running away upward; each step alone is within +25%
        t += 301
        win = window_bounds(sent[::-1], t, floor)
        v, _ = clamp_step(10**6, sent[-1][1], floor, win)
        sent.append((t, v))
        values.append(v)
    # 3000 -> 3750 -> 4500 (the step rule alone would allow 4687, but 3000 * 1.5 = 4500 is in force) -> stays 4500.
    assert values == [3000, 3750, 4500, 4500, 4500]
    # Without the window the third step would have breached it.
    assert clamp_step(10**6, 3750, floor)[0] == 4687 and 4687 * 10_000 > 3000 * 15_000


def test_engine_rate_limit_skips_even_when_forced_and_window_is_applied():
    st = store_with_ticks(bar_vol=0.0001)
    s = settings(send=True, rpc_url="http://unused")
    first = run_cycle(NOW, st, SentSender(), s, History(), force=True)
    assert len(first) == 2 and {i.status for i in st.intents} == {"sent"}
    # 60 s later and 299 s later: skipped (log + continue), nothing signed, no new rows.
    for dt in (60, 299):
        assert run_cycle(NOW + timedelta(seconds=dt), st, SentSender(), s, History(), force=True) == []
    assert len(st.intents) == 2
    # At exactly 300 s the contract accepts again.
    third = run_cycle(NOW + timedelta(seconds=300), st, SentSender(), s, History(), force=True)
    assert len(third) == 2 and len(st.intents) == 4
    # Rate limit is per stock and speed: dry-run intents never count.
    dry = store_with_ticks(bar_vol=0.0001)
    d = settings()
    assert len(run_cycle(NOW, dry, DryRunSender(), d, History(), force=True)) == 2
    assert len(run_cycle(NOW + timedelta(seconds=1), dry, DryRunSender(), d, History(), force=True)) == 2


def test_plan_clamps_to_the_rolling_hour_bounds_from_sent_intents():
    st = store_with_ticks(bar_vol=0.01)  # very high realized vol: the target is far above any bound
    from vol_engine.store import Intent

    def sent(at, sigma, nonce):
        st.intents.append(Intent(NVDA, "NVDA", "DAILY", sigma, 0, 0, 0, 0, 0, nonce, "0x", "0x", "sent", created_at=at))

    now_s = NOW.timestamp()
    sent(now_s - 3000, 3000, 1)  # in force 50 min ago, so the cap is 4500 even though the last post is 4400
    sent(now_s - 400, 4400, 2)
    plan = plan_post("NVDA", 0, NOW, st, History(), 3600, False)
    assert plan.post.sigma_bps == 4500 and plan.ramped


# ---- F43: a dead indexer must not keep a stale sigma alive ------------------------------------------------------


def test_stale_ticks_are_refused_and_alerted_so_the_oracle_can_go_stale():
    st = store_with_ticks()
    assert len(run_cycle(NOW, st, DryRunSender(), settings(), History(), force=True)) == 2
    st.intents.clear()
    # The indexer died 40 minutes ago: nothing is signed any more, and an alert says why.
    late = NOW + timedelta(minutes=40)
    assert run_cycle(late, st, DryRunSender(), settings(), History(), force=True) == []
    assert st.intents == [] and any(k == "stale_ticks" for _, _, k, _ in st.alerts)
    # The same for a weekend: a Friday-afternoon stall must not carry the weekend state into Monday.
    st2 = store_with_ticks()
    st2.tick_rows[NVDA].append(Tick(NOW.timestamp(), st2.tick_rows[NVDA][-1].spot, "CLOSED", True))
    monday = NOW + timedelta(days=2, hours=2)
    assert run_cycle(monday, st2, DryRunSender(), settings(), History(), force=True) == []


def test_fresh_ticks_still_post():
    st = store_with_ticks()
    assert len(run_cycle(NOW + timedelta(minutes=20), st, DryRunSender(), settings(), History(), force=True)) == 2


# ---- F44: "sent" means a receipt, not a transaction hash ---------------------------------------------------------


class ReceiptChain:
    """A transport whose receipts the test controls: None until `mined` is set, then the given status."""

    def __init__(self):
        self.receipt = None

    def __call__(self, method, params):
        if method == "eth_getTransactionReceipt":
            return self.receipt
        return {"eth_getTransactionCount": "0x5", "eth_gasPrice": "0x3b9aca00", "eth_estimateGas": "0x30d40",
                "eth_sendRawTransaction": "0x" + "ab" * 32}[method]


def test_a_broadcast_without_a_receipt_stays_pending_and_is_not_a_step_reference():
    st = store_with_ticks()
    s = settings(send=True, rpc_url="http://unused", sender_key=ANVIL_KEY)
    chain = ReceiptChain()
    sender = make_sender(s, chain, sleep=lambda _: None)
    run_cycle(NOW, st, sender, s, History(), force=True)
    assert {i.status for i in st.intents} == {"pending"}
    assert st.reference(NVDA, "DAILY", False) is None  # a phantom is no reference for the next step
    assert st.recent_sent(NVDA, "DAILY", NOW.timestamp()) == []
    # The next pass waits for the receipt rather than stacking another post on a maybe-dropped one.
    assert run_cycle(NOW + timedelta(minutes=6), st, sender, s, History(), force=True) == []
    chain.receipt = {"status": "0x1"}
    run_cycle(NOW + timedelta(minutes=7), st, sender, s, History(), force=True)
    assert {i.status for i in st.intents[:2]} == {"sent"}
    assert st.reference(NVDA, "DAILY", False) is not None


def test_a_dropped_post_is_marked_failed_alerted_and_replanned_from_the_real_reference():
    st = store_with_ticks()
    s = settings(send=True, rpc_url="http://unused", sender_key=ANVIL_KEY)
    chain = ReceiptChain()
    sender = make_sender(s, chain, sleep=lambda _: None)
    run_cycle(NOW, st, sender, s, History(), force=True)
    later = NOW + timedelta(minutes=20)
    st.tick_rows[NVDA].append(Tick(later.timestamp() - 30, st.tick_rows[NVDA][-1].spot, "REGULAR", True))
    run_cycle(later, st, sender, s, History(), force=True)
    assert [i.status for i in st.intents[:2]] == ["failed", "failed"]
    assert any(k == "post_dropped" for _, _, k, _ in st.alerts)
    assert len(st.intents) == 4 and {i.status for i in st.intents[2:]} == {"pending"}  # re-planned with fresh nonces


def test_a_reverted_post_is_failed_not_sent():
    st = store_with_ticks()
    s = settings(send=True, rpc_url="http://unused", sender_key=ANVIL_KEY)
    chain = ReceiptChain()
    chain.receipt = {"status": "0x0"}
    run_cycle(NOW, st, make_sender(s, chain, sleep=lambda _: None), s, History(), force=True)
    assert {i.status for i in st.intents} == {"failed"}


# ---- F45: a sliding force-block window must not make every pass a change ----------------------------------------


def test_force_block_window_is_kept_so_loop_mode_does_not_repost_every_pass():
    st = store_with_ticks(bar_vol=0.0001)
    st.earnings_rows = [EarningsRow("NVDA", date(2026, 10, 20), "post", SOURCE_A),
                        EarningsRow("NVDA", date(2026, 10, 27), "post", SOURCE_B)]
    s = settings()
    first = run_cycle(NOW, st, DryRunSender(), s, History(), force=False)
    assert len(first) == 2
    window = (first[0].post.buy_block_from, first[0].post.buy_block_to)
    # Six more 5-minute passes (the indexer keeps writing ticks): same window, so no new posts until near expiry.
    for k in range(1, 7):
        t = NOW + timedelta(minutes=5 * k)
        st.tick_rows[NVDA].append(Tick(t.timestamp() - 30, st.tick_rows[NVDA][-1].spot, "REGULAR", True))
        assert run_cycle(t, st, DryRunSender(), s, History(), force=False) == [], f"pass {k} re-posted"
    assert [(i.buy_block_from, i.buy_block_to) for i in st.intents if i.speed == "DAILY"] == [window]


def test_force_block_window_is_renewed_when_less_than_23h_remain():
    st = store_with_ticks(bar_vol=0.0001)
    st.earnings_rows = [EarningsRow("NVDA", date(2026, 10, 20), "post", SOURCE_A),
                        EarningsRow("NVDA", date(2026, 10, 27), "post", SOURCE_B)]
    s = settings()
    run_cycle(NOW, st, DryRunSender(), s, History(), force=True)
    later = NOW + timedelta(hours=2)
    st.tick_rows[NVDA].append(Tick(later.timestamp() - 30, st.tick_rows[NVDA][-1].spot, "REGULAR", True))
    plans = run_cycle(later, st, DryRunSender(), s, History(), force=True)
    assert plans[0].post.buy_block_to == int(later.timestamp()) + 86_400  # it never lapses while the sources disagree
