// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IMarketHours} from "./interfaces/IMarketHours.sol";
import {Roles} from "./libs/Roles.sol";
import {Session} from "./libs/LemniscateTypes.sol";
import {SessionKind} from "./libs/OptionTypes.sol";
import {Holiday, NyseCalendar} from "./libs/NyseCalendar.sol";

/// @title MarketHours
/// @notice Keeper-pushed market sessions used by the engine to select its pricing regime.
/// @dev Each pushed session carries a kind (REGULAR or EXTENDED). When the pushed calendar covers a timestamp
/// ([first open, last close)) it is authoritative: inside a session -> its kind, in a gap -> CLOSED. Outside that
/// range the admin-enabled NyseCalendar fallback answers, else UNKNOWN.
contract MarketHours is Initializable, AccessControlUpgradeable, UUPSUpgradeable, IMarketHours {
    uint256 public constant MAX_SESSIONS = 32;
    uint256 public constant MAX_SESSION_LENGTH = 5 days + 1 hours;
    uint256 public constant MAX_HORIZON = 30 days;

    bytes32 public constant override KEEPER_ROLE = Roles.KEEPER_ROLE;

    Session[] private _sessions;
    /// @dev Parallel to `_sessions`. Appended storage (upgrade-safe: taken from the gap below).
    SessionKind[] private _kinds;
    Holiday[] private _holidays;
    bool private _fallbackEnabled;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /// @notice Initializes roles for the Safe admin and keeper.
    function initialize(address admin, address keeper) external override initializer {
        if (admin == address(0)) revert InvalidAdmin();
        if (keeper == address(0)) revert InvalidKeeper();

        __AccessControl_init();
        __UUPSUpgradeable_init();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _grantRole(KEEPER_ROLE, keeper);
    }

    /// @notice Replaces the pushed calendar with a validated list of sessions.
    function setSessions(Session[] calldata newSessions) external override onlyRole(KEEPER_ROLE) {
        SessionKind[] memory kinds = new SessionKind[](newSessions.length); // all REGULAR (enum value 0)
        _storeSessions(newSessions, kinds);
    }

    /// @notice Replaces the pushed calendar with sessions that each carry a kind (REGULAR or EXTENDED).
    function setSessionsWithKinds(Session[] calldata newSessions, SessionKind[] calldata kinds)
        external
        override
        onlyRole(KEEPER_ROLE)
    {
        if (kinds.length != newSessions.length) revert SessionKindsLength(newSessions.length, kinds.length);
        for (uint256 i; i < kinds.length; ++i) {
            if (kinds[i] != SessionKind.REGULAR && kinds[i] != SessionKind.EXTENDED) revert InvalidSessionKind(i);
        }
        _storeSessions(newSessions, kinds);
    }

    function _storeSessions(Session[] calldata newSessions, SessionKind[] memory kinds) private {
        uint256 count = newSessions.length;
        if (count > MAX_SESSIONS) revert TooManySessions(count);

        uint64 previousClose;
        for (uint256 i; i < count; ++i) {
            Session calldata session = newSessions[i];
            if (session.close <= session.open) revert InvalidSession(i);
            if (uint256(session.close) - uint256(session.open) > MAX_SESSION_LENGTH) revert SessionTooLong(i);
            if (i != 0) {
                if (session.open < newSessions[i - 1].open) revert SessionsUnsorted(i);
                if (session.open < previousClose) revert SessionsOverlap(i);
            }
            previousClose = session.close;
        }
        if (count != 0 && uint256(newSessions[count - 1].close) > block.timestamp + MAX_HORIZON) {
            revert SessionTooFar(count - 1);
        }

        delete _sessions;
        delete _kinds;
        for (uint256 i; i < count; ++i) {
            _sessions.push(newSessions[i]);
            _kinds.push(kinds[i]);
        }

        uint64 firstOpen = count == 0 ? 0 : newSessions[0].open;
        uint64 lastClose = count == 0 ? 0 : newSessions[count - 1].close;
        emit SessionsUpdated(count, firstOpen, lastClose);
    }

    /// @notice Returns whether timestamp falls within a stored half-open session interval.
    function isOpen(uint256 timestamp) external view override returns (bool) {
        // Sessions are sorted and non-overlapping: binary-search the last session opening at or before timestamp.
        uint256 low;
        uint256 high = _sessions.length;
        while (low < high) {
            uint256 mid = (low + high) / 2;
            if (_sessions[mid].open <= timestamp) low = mid + 1;
            else high = mid;
        }
        return low != 0 && timestamp < _sessions[low - 1].close;
    }

    /// @notice Returns all stored sessions, including expired sessions awaiting pruning.
    function sessions() external view override returns (Session[] memory) {
        return _sessions;
    }

    /// @notice Returns the active interval, if any, and the next opening time.
    /// @dev When closed, open and close are zero; nextOpen is the earliest future session open or zero.
    function currentSession()
        external
        view
        override
        returns (bool openNow, uint64 open, uint64 close, uint64 nextOpen)
    {
        uint256 now_ = block.timestamp;
        uint256 count = _sessions.length;
        for (uint256 i; i < count; ++i) {
            Session storage session = _sessions[i];
            if (now_ >= session.open && now_ < session.close) {
                uint64 followingOpen = i + 1 < count ? _sessions[i + 1].open : 0;
                return (true, session.open, session.close, followingOpen);
            }
            if (now_ < session.open) return (false, 0, 0, session.open);
        }
        return (false, 0, 0, 0);
    }

    /// @notice Admin-set holiday and early-close list for the fallback calendar. Strictly ascending by Eastern day,
    /// at most 64 entries, early-close minute (if any) strictly between the regular open and the regular close.
    function setHolidays(Holiday[] calldata newHolidays) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 count = newHolidays.length;
        if (count > NyseCalendar.MAX_HOLIDAYS) revert TooManyHolidays(count);
        for (uint256 i; i < count; ++i) {
            uint256 close = newHolidays[i].closeMinute;
            if (close != 0 && (close <= NyseCalendar.REGULAR_OPEN || close >= NyseCalendar.REGULAR_CLOSE)) {
                revert InvalidHoliday(i);
            }
            if (i != 0 && newHolidays[i].day <= newHolidays[i - 1].day) revert HolidaysUnsorted(i);
        }
        delete _holidays;
        for (uint256 i; i < count; ++i) {
            _holidays.push(newHolidays[i]);
        }
        emit HolidaysUpdated(count);
    }

    /// @notice Turns the on-chain NYSE fallback calendar on or off (off by default: set holidays first).
    function setFallbackEnabled(bool enabled) external override onlyRole(DEFAULT_ADMIN_ROLE) {
        _fallbackEnabled = enabled;
        emit FallbackEnabledSet(enabled);
    }

    /// @inheritdoc IMarketHours
    function kindAt(uint256 ts) external view override returns (SessionKind) {
        uint256 count = _sessions.length;
        if (count != 0 && ts >= _sessions[0].open && ts < _sessions[count - 1].close) {
            uint256 low;
            uint256 high = count;
            while (low < high) {
                uint256 mid = (low + high) / 2;
                if (_sessions[mid].open <= ts) low = mid + 1;
                else high = mid;
            }
            // low >= 1 because ts >= _sessions[0].open.
            if (ts < _sessions[low - 1].close) return _kinds[low - 1];
            return SessionKind.CLOSED;
        }
        if (_fallbackEnabled) return NyseCalendar.kindAt(ts, _holidays);
        return SessionKind.UNKNOWN;
    }

    function sessionKinds() external view override returns (SessionKind[] memory) {
        return _kinds;
    }

    function holidays() external view override returns (Holiday[] memory) {
        return _holidays;
    }

    function fallbackEnabled() external view override returns (bool) {
        return _fallbackEnabled;
    }

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    uint256[42] private __gap;
}
