// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SessionKind} from "./OptionTypes.sol";

/// @notice One NYSE calendar exception, keyed by the US Eastern calendar day (days since 1970-01-01 in local time).
/// @dev closeMinute == 0 means the exchange is closed all day (full holiday). A non-zero closeMinute is an early close:
/// the regular session ends at that Eastern minute of the day (780 = 13:00).
struct Holiday {
    uint32 day;
    uint16 closeMinute;
}

/// @title NyseCalendar
/// @notice On-chain fallback calendar for US equity sessions, used only when no keeper-pushed calendar covers a time.
/// @dev Eastern time offset uses the US daylight-saving rules for 2026 to 2028 as fixed transition instants; any
/// timestamp outside [SUPPORTED_FROM, SUPPORTED_TO) is UNKNOWN. Holidays are supplied by the caller (admin-set list).
///
/// Sessions, in Eastern time, on a trading day D (Mon-Fri and not a full holiday):
///   overnight  20:00 on D-1 to 04:00 on D  -> EXTENDED (single-provider window)
///   pre-market 04:00 to 09:30               -> EXTENDED
///   regular    09:30 to 16:00 (or the early close) -> REGULAR
///   post       16:00 (or the early close) to 20:00 -> EXTENDED
/// Everything else is CLOSED. The overnight window belongs to the trading day it leads into, so it runs Sunday
/// evening to Friday morning, and the evening before a holiday is CLOSED.
library NyseCalendar {
    uint256 internal constant SUPPORTED_FROM = 1_767_225_600; // 2026-01-01T00:00:00Z
    uint256 internal constant SUPPORTED_TO = 1_861_920_000; // 2029-01-01T00:00:00Z

    // DST start (second Sunday of March, 02:00 EST = 07:00Z) and end (first Sunday of November, 02:00 EDT = 06:00Z).
    uint256 internal constant DST_START_2026 = 1_772_953_200; // 2026-03-08T07:00:00Z
    uint256 internal constant DST_END_2026 = 1_793_512_800; // 2026-11-01T06:00:00Z
    uint256 internal constant DST_START_2027 = 1_805_007_600; // 2027-03-14T07:00:00Z
    uint256 internal constant DST_END_2027 = 1_825_567_200; // 2027-11-07T06:00:00Z
    uint256 internal constant DST_START_2028 = 1_836_457_200; // 2028-03-12T07:00:00Z
    uint256 internal constant DST_END_2028 = 1_857_016_800; // 2028-11-05T06:00:00Z

    uint256 internal constant EST_OFFSET = 5 hours;
    uint256 internal constant EDT_OFFSET = 4 hours;

    uint256 internal constant OVERNIGHT_END = 4 * 60; // 04:00
    uint256 internal constant REGULAR_OPEN = 9 * 60 + 30; // 09:30
    uint256 internal constant REGULAR_CLOSE = 16 * 60; // 16:00
    uint256 internal constant EXTENDED_END = 20 * 60; // 20:00

    uint256 internal constant MAX_HOLIDAYS = 64;

    /// @notice True when the timestamp falls inside the years the fallback calendar knows.
    function supported(uint256 ts) internal pure returns (bool) {
        return ts >= SUPPORTED_FROM && ts < SUPPORTED_TO;
    }

    /// @notice Seconds to subtract from UTC to get US Eastern local time. Caller must check `supported(ts)`.
    function etOffset(uint256 ts) internal pure returns (uint256) {
        if (
            (ts >= DST_START_2026 && ts < DST_END_2026) || (ts >= DST_START_2027 && ts < DST_END_2027)
                || (ts >= DST_START_2028 && ts < DST_END_2028)
        ) return EDT_OFFSET;
        return EST_OFFSET;
    }

    /// @notice Eastern local day number (days since 1970-01-01) and minute of that day. Caller must check support.
    function localDayMinute(uint256 ts) internal pure returns (uint256 day, uint256 minute) {
        uint256 local = ts - etOffset(ts);
        day = local / 1 days;
        minute = (local % 1 days) / 1 minutes;
    }

    /// @notice 0 = Sunday ... 6 = Saturday. 1970-01-01 was a Thursday.
    function dayOfWeek(uint256 day) internal pure returns (uint256) {
        return (day + 4) % 7;
    }

    /// @notice Regular-session close minute for `day`, or 0 when the market is closed all day (weekend or holiday).
    function closeMinuteOf(uint256 day, Holiday[] storage holidays) internal view returns (uint256) {
        uint256 dow = dayOfWeek(day);
        if (dow == 0 || dow == 6) return 0;
        uint256 count = holidays.length;
        for (uint256 i; i < count; ++i) {
            Holiday storage h = holidays[i];
            if (h.day == day) return h.closeMinute; // 0 = full holiday
            if (h.day > day) break; // list is sorted ascending
        }
        return REGULAR_CLOSE;
    }

    /// @notice Session kind at `ts` from the fallback calendar. UNKNOWN outside the supported years.
    function kindAt(uint256 ts, Holiday[] storage holidays) internal view returns (SessionKind) {
        if (!supported(ts)) return SessionKind.UNKNOWN;
        (uint256 day, uint256 minute) = localDayMinute(ts);

        if (minute >= EXTENDED_END) {
            // Overnight window leading into the next day.
            return closeMinuteOf(day + 1, holidays) == 0 ? SessionKind.CLOSED : SessionKind.EXTENDED;
        }
        uint256 close = closeMinuteOf(day, holidays);
        if (close == 0) return SessionKind.CLOSED;
        if (minute < REGULAR_OPEN) return SessionKind.EXTENDED; // overnight tail (00:00-04:00) and pre-market
        if (minute < close) return SessionKind.REGULAR;
        return SessionKind.EXTENDED; // post-market until 20:00
    }
}
