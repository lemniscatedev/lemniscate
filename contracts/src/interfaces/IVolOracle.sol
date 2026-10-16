// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Speed, VolReading} from "../libs/OptionTypes.sol";

interface IVolOracle {
    event VolPosted(address indexed stock, Speed indexed speed, uint64 sigmaBps, uint64 skewK, uint64 eventBumpBps, uint64 validUntil, uint64 nonce);
    event SignerSet(address indexed signer);
    error BadSignature();
    error StepTooLarge(uint64 prior, uint64 next);
    error BelowFloor(uint64 sigmaBps, uint64 floorBps);
    error Expired();
    error NonceUsed(uint64 nonce);

    struct Post {
        address stock;
        Speed speed;
        uint64 sigmaBps;
        uint64 skewK;
        uint64 eventBumpBps;
        uint64 buyBlockFrom;
        uint64 buyBlockTo;
        uint64 validUntil;
        uint64 nonce;
    }

    /// @dev EIP-712 typed data signed by the vol-engine signer. Guards: |change| <= 25% of prior (first post exempt),
    /// sigmaBps >= floor(stock), validUntil within 2h of now.
    function post(Post calldata p, bytes calldata sig) external;
    function setSigner(address signer) external;
    function setFloor(address stock, uint64 floorBps) external;
    function read(address stock, Speed speed) external view returns (VolReading memory);
    function signer() external view returns (address);
}
