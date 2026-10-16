// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IVolOracle} from "./interfaces/IVolOracle.sol";
import {Speed, VolReading} from "./libs/OptionTypes.sol";

/// @title VolOracle
/// @notice Holds the annualised volatility (sigma, bps) per stock and speed, posted by the off-chain vol-engine signer
/// as EIP-712 typed data. Anyone may submit a signed post; the signature, not the sender, is what is trusted.
/// @dev Rules (see the test names in test/VolOracle.t.sol):
///  - The signature is checked first, against the current signer, over every field of the post plus the domain
///    (name "LemniscateVolOracle", version "1", chainId, this contract). High-s and malformed signatures are rejected.
///  - `validUntil` must be in the future and at most `MAX_VALIDITY` (2h) ahead.
///  - The nonce is strictly increasing per stock and speed (the first accepted nonce is >= 1).
///  - sigma must be >= the stock's floor (DEFAULT_FLOOR_BPS until the admin sets one).
///  - sigma may move at most 25% per post. The reference is the prior sigma, or the floor when the floor was raised
///    above the prior (so a floor increase cannot leave a name with no acceptable post). The first post per stock and
///    speed has no prior and only has to clear the floor.
///  - The earnings buy-block window must have to >= from and a length of at most 3 days (0/0 = no window).
///  - `read` never reverts. After `validUntil` it reports stale = true and still returns the last values: the engine
///    decides what stale means (buys pause, sells use the last sigma plus a bump).
///  - Only the admin (the timelock) rotates the signer and sets floors. A rotation invalidates every unsubmitted post
///    signed by the old key.
contract VolOracle is AccessControl, EIP712, IVolOracle {
    /// @notice EIP-712 type of a post. `speed` is the Speed enum as uint8 (0 = DAILY, 1 = WEEKLY).
    bytes32 public constant POST_TYPEHASH = keccak256(
        "Post(address stock,uint8 speed,uint64 sigmaBps,uint64 skewK,uint64 eventBumpBps,uint64 buyBlockFrom,uint64 buyBlockTo,uint64 validUntil,uint64 nonce)"
    );

    /// @notice Largest move per post, in bps of the reference sigma (25%).
    uint64 public constant MAX_STEP_BPS = 2500;
    /// @notice Floor applied to a stock the admin has not configured (30%, mega-cap level).
    uint64 public constant DEFAULT_FLOOR_BPS = 3000;
    /// @notice A post may be valid for at most this long after it lands.
    uint64 public constant MAX_VALIDITY = 2 hours;
    /// @notice Longest earnings buy-block window.
    uint64 public constant MAX_BUY_BLOCK = 3 days;
    /// @notice Upper bound for an admin floor (1000%), so a typo cannot freeze a name.
    uint64 public constant MAX_FLOOR_BPS = 100_000;

    uint256 private constant BPS = 10_000;

    error InvalidAdmin();
    error InvalidSigner();
    error InvalidFloor(uint64 floorBps);
    error BadBuyBlockWindow(uint64 from, uint64 to);

    event FloorSet(address indexed stock, uint64 floorBps);

    /// @dev Two storage slots per stock and speed.
    struct Slot {
        uint64 sigmaBps;
        uint64 skewK;
        uint64 eventBumpBps;
        uint64 buyBlockFrom;
        uint64 buyBlockTo;
        uint64 validUntil;
        uint64 nonce;
    }

    struct Floor {
        uint64 bps;
        bool set;
    }

    address public signer;
    mapping(address stock => mapping(Speed speed => Slot)) private _vol;
    mapping(address stock => Floor) private _floor;

    constructor(address admin, address signer_) EIP712("LemniscateVolOracle", "1") {
        if (admin == address(0)) revert InvalidAdmin();
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _setSigner(signer_);
    }

    // ------------------------------------------------------------------ admin

    function setSigner(address signer_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setSigner(signer_);
    }

    function setFloor(address stock, uint64 floorBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (floorBps == 0 || floorBps > MAX_FLOOR_BPS) revert InvalidFloor(floorBps);
        _floor[stock] = Floor({bps: floorBps, set: true});
        emit FloorSet(stock, floorBps);
    }

    // ------------------------------------------------------------------ post

    function post(Post calldata p, bytes calldata sig) external {
        (address recovered, ECDSA.RecoverError err,) = ECDSA.tryRecover(hashPost(p), sig);
        if (err != ECDSA.RecoverError.NoError || recovered != signer) revert BadSignature();

        if (p.validUntil <= block.timestamp || p.validUntil > block.timestamp + MAX_VALIDITY) revert Expired();

        Slot storage s = _vol[p.stock][p.speed];
        if (p.nonce <= s.nonce) revert NonceUsed(p.nonce);

        uint64 floor_ = floorOf(p.stock);
        if (p.sigmaBps < floor_) revert BelowFloor(p.sigmaBps, floor_);

        uint64 prior = s.sigmaBps;
        if (prior != 0) {
            uint64 ref = prior < floor_ ? floor_ : prior;
            uint256 diff = p.sigmaBps > ref ? p.sigmaBps - ref : ref - p.sigmaBps;
            if (diff * BPS > uint256(ref) * MAX_STEP_BPS) revert StepTooLarge(prior, p.sigmaBps);
        }

        if (p.buyBlockTo < p.buyBlockFrom || p.buyBlockTo - p.buyBlockFrom > MAX_BUY_BLOCK) {
            revert BadBuyBlockWindow(p.buyBlockFrom, p.buyBlockTo);
        }

        _vol[p.stock][p.speed] = Slot({
            sigmaBps: p.sigmaBps,
            skewK: p.skewK,
            eventBumpBps: p.eventBumpBps,
            buyBlockFrom: p.buyBlockFrom,
            buyBlockTo: p.buyBlockTo,
            validUntil: p.validUntil,
            nonce: p.nonce
        });
        emit VolPosted(p.stock, p.speed, p.sigmaBps, p.skewK, p.eventBumpBps, p.validUntil, p.nonce);
    }

    // ------------------------------------------------------------------ views

    /// @notice Last posted values. A stock and speed that was never posted reads sigma 0 and stale = true.
    function read(address stock, Speed speed) external view returns (VolReading memory r) {
        Slot memory s = _vol[stock][speed];
        r = VolReading({
            sigmaBps: s.sigmaBps,
            skewK: s.skewK,
            eventBumpBps: s.eventBumpBps,
            buyBlockFrom: s.buyBlockFrom,
            buyBlockTo: s.buyBlockTo,
            validUntil: s.validUntil,
            stale: block.timestamp > s.validUntil
        });
    }

    function floorOf(address stock) public view returns (uint64) {
        Floor memory f = _floor[stock];
        return f.set ? f.bps : DEFAULT_FLOOR_BPS;
    }

    function lastNonce(address stock, Speed speed) external view returns (uint64) {
        return _vol[stock][speed].nonce;
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    function structHash(Post calldata p) public pure returns (bytes32) {
        return keccak256(
            abi.encode(
                POST_TYPEHASH,
                p.stock,
                uint8(p.speed),
                p.sigmaBps,
                p.skewK,
                p.eventBumpBps,
                p.buyBlockFrom,
                p.buyBlockTo,
                p.validUntil,
                p.nonce
            )
        );
    }

    /// @notice The EIP-712 digest the signer signs for `p`.
    function hashPost(Post calldata p) public view returns (bytes32) {
        return _hashTypedDataV4(structHash(p));
    }

    // ------------------------------------------------------------------ internal

    function _setSigner(address signer_) private {
        if (signer_ == address(0)) revert InvalidSigner();
        signer = signer_;
        emit SignerSet(signer_);
    }
}
