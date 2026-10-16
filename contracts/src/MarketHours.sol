// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlUpgradeable} from "@openzeppelin/contracts-upgradeable/access/AccessControlUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {IMarketHours} from "./interfaces/IMarketHours.sol";
import {Roles} from "./libs/Roles.sol";
import {Session} from "./libs/LemniscateTypes.sol";

/// @title MarketHours
/// @notice Keeper-pushed market sessions used by the engine to select its pricing regime.
contract MarketHours is Initializable, AccessControlUpgradeable, UUPSUpgradeable, IMarketHours {
    uint256 public constant MAX_SESSIONS = 32;
    uint256 public constant MAX_SESSION_LENGTH = 5 days + 1 hours;
    uint256 public constant MAX_HORIZON = 30 days;

    bytes32 public constant override KEEPER_ROLE = Roles.KEEPER_ROLE;

    Session[] private _sessions;

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
        for (uint256 i; i < count; ++i) {
            _sessions.push(newSessions[i]);
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

    function _authorizeUpgrade(address) internal override onlyRole(DEFAULT_ADMIN_ROLE) {}

    uint256[45] private __gap;
}
