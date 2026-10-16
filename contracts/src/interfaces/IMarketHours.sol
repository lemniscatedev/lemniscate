// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {Session} from "../libs/LemniscateTypes.sol";

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

    function KEEPER_ROLE() external view returns (bytes32);

    function initialize(address admin, address keeper) external;

    function setSessions(Session[] calldata newSessions) external;

    function isOpen(uint256 timestamp) external view returns (bool);

    function sessions() external view returns (Session[] memory);

    function currentSession() external view returns (bool openNow, uint64 open, uint64 close, uint64 nextOpen);
}
