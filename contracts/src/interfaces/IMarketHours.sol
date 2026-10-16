// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Session} from "../libs/LemniscateTypes.sol";
import {SessionKind} from "../libs/OptionTypes.sol";
import {Holiday} from "../libs/NyseCalendar.sol";

interface IMarketHours is IAccessControl {
    error InvalidAdmin();
    error InvalidKeeper();
    error TooManySessions(uint256 count);
    error InvalidSession(uint256 index);
    error SessionsUnsorted(uint256 index);
    error SessionsOverlap(uint256 index);
    error SessionTooLong(uint256 index);
    error SessionTooFar(uint256 index);

    event SessionsUpdated(uint256 count, uint64 firstOpen, uint64 lastClose);

    // Added for session kinds (todo 04). Existing members above are unchanged.
    error SessionKindsLength(uint256 sessions, uint256 kinds);
    error InvalidSessionKind(uint256 index);
    error TooManyHolidays(uint256 count);
    error HolidaysUnsorted(uint256 index);
    error InvalidHoliday(uint256 index);

    event HolidaysUpdated(uint256 count);
    event FallbackEnabledSet(bool enabled);

    function KEEPER_ROLE() external view returns (bytes32);

    function initialize(address admin, address keeper) external;

    function setSessions(Session[] calldata newSessions) external;

    function isOpen(uint256 timestamp) external view returns (bool);

    function sessions() external view returns (Session[] memory);

    function currentSession() external view returns (bool openNow, uint64 open, uint64 close, uint64 nextOpen);

    /// @notice Keeper push with a kind per session (REGULAR or EXTENDED). `setSessions` stores every session as REGULAR.
    function setSessionsWithKinds(Session[] calldata newSessions, SessionKind[] calldata kinds) external;

    /// @notice Admin-set NYSE holiday and early-close list for the fallback calendar (sorted, at most 64 entries).
    function setHolidays(Holiday[] calldata newHolidays) external;

    function setFallbackEnabled(bool enabled) external;

    /// @notice Session kind at `ts`: pushed calendar when it covers `ts`, else the NyseCalendar fallback when enabled,
    /// else UNKNOWN. Never HALTED (that is PriceGuard's call).
    function kindAt(uint256 ts) external view returns (SessionKind);

    function sessionKinds() external view returns (SessionKind[] memory);

    function holidays() external view returns (Holiday[] memory);

    function fallbackEnabled() external view returns (bool);
}
