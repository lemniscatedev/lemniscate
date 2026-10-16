from datetime import date, datetime, timezone

from vol_engine.earnings import SOURCE_A, SOURCE_B, EarningsRow, reconcile, report_times

NOW = datetime(2026, 10, 19, 15, 0, tzinfo=timezone.utc)  # Monday


def rows(a=None, b=None, sa="post", sb="post"):
    out = []
    if a:
        out.append(EarningsRow("TSLA", date.fromisoformat(a), sa, SOURCE_A))
    if b:
        out.append(EarningsRow("TSLA", date.fromisoformat(b), sb, SOURCE_B))
    return out


def test_report_times_block_window_60_before_30_after():
    rep, lo, hi, _ = report_times(date(2026, 10, 21), "post")
    assert rep - lo == 3600 and hi - rep == 1800
    rep, lo, hi, _ = report_times(date(2026, 10, 21), "pre")
    assert rep - lo == 3600 and hi - rep == 1800
    # Unknown session: the window must contain both the pre and the post window.
    _, ulo, uhi, _ = report_times(date(2026, 10, 21), "unknown")
    _, plo, _, _ = report_times(date(2026, 10, 21), "pre")
    _, _, qhi, _ = report_times(date(2026, 10, 21), "post")
    assert ulo == plo and uhi == qhi


def test_twoSourceEarnings_agree_confirms_the_date():
    d = reconcile("TSLA", rows("2026-10-21", "2026-10-21", sa="unknown", sb="post"), NOW)
    assert d.status == "confirmed" and d.report_date == date(2026, 10, 21) and d.session == "post"
    assert d.force_block is None and d.alerts == []


def test_twoSourceEarnings_within_one_day_still_agrees():
    d = reconcile("TSLA", rows("2026-10-21", "2026-10-22"), NOW)
    assert d.status == "confirmed" and d.report_date == date(2026, 10, 21)


def test_twoSourceEarnings_disagreement_blocks_buys_24h_and_alerts():
    d = reconcile("TSLA", rows("2026-10-21", "2026-10-24"), NOW)
    assert d.status == "disagree"
    now_s = int(NOW.timestamp())
    assert d.force_block == (now_s, now_s + 86_400)
    assert d.alerts and d.alerts[0][0] == "earnings_sources_disagree"
    assert d.report_date is None  # never picks a side, never invents a date


def test_twoSourceEarnings_missing_source_blocks_when_report_is_near():
    d = reconcile("TSLA", rows(a="2026-10-21"), NOW)
    assert d.status == "missing_source" and d.force_block is not None
    assert d.alerts[0][1]["missing"] == SOURCE_B
    d = reconcile("TSLA", rows(b="2026-10-21"), NOW)
    assert d.alerts[0][1]["missing"] == SOURCE_A and d.force_block is not None


def test_twoSourceEarnings_far_dates_alert_but_do_not_block():
    d = reconcile("TSLA", rows(a="2027-01-20"), NOW)
    assert d.status == "missing_source" and d.force_block is None and d.alerts


def test_twoSourceEarnings_no_dates_at_all_never_invents_one():
    d = reconcile("TSLA", [], NOW)
    assert d.status == "none" and d.report_date is None and d.alerts


def test_etfs_have_no_earnings():
    d = reconcile("SPY", [], NOW)
    assert d.status == "no_earnings" and d.alerts == [] and d.force_block is None


def test_past_reports_are_ignored():
    d = reconcile("TSLA", rows("2026-10-01", "2026-10-01"), NOW)
    assert d.status == "none"
