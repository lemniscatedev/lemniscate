// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IVolOracle} from "./interfaces/IVolOracle.sol";
import {Speed, VolReading} from "./libs/OptionTypes.sol";
import {Roles} from "./libs/Roles.sol";

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
///  - Rate limit (todo 04b R7, `volRateLimit`): at most one accepted post per stock and speed per MIN_POST_INTERVAL
///    (5 min), and a new sigma must be within +-50% of every sigma in force during the last rolling hour (each lifted
///    to the floor, like the step reference). That bounds any rolling 1h move to +-50% of the value at the start of
///    the hour, so a compromised signer posting maximum steps walks sigma at most 1.5x (or 0.5x) per hour, not 25%
///    per transaction. The last HISTORY (12) accepted posts are kept per stock and speed; with one post per 5 minutes
///    that always covers the hour plus the value in force at its start. The first post is exempt (no history).
///  - skewK (review F20): each coefficient is capped (k_put <= MAX_SKEW_PUT = 3.0, k_call <= MAX_SKEW_CALL = 1.0 at 1e4
///    scale; decision 17 default 1.2 / 0.4), including on the first post, and may move at most MAX_SKEW_STEP (0.2) per
///    post, so a stolen signer key cannot reprice every strike off S at the 300% clamp in one post.
///  - The guardian can revoke the signer at once (`revokeSigner`): every post then fails until the admin (timelock)
///    sets a new signer. While no post lands the vol goes stale: buys stop and sells use a lowered sigma (engine).
contract VolOracle is AccessControl, EIP712, IVolOracle {
    /// @notice EIP-712 type of a post. `speed` is the Speed enum as uint8 (0 = DAILY, 1 = WEEKLY).
    bytes32 public constant POST_TYPEHASH = keccak256(
        "Post(address stock,uint8 speed,uint64 sigmaBps,uint64 skewK,uint64 eventBumpBps,uint64 buyBlockFrom,uint64 buyBlockTo,uint64 validUntil,uint64 nonce)"
    );

    /// @notice Largest move per post, in bps of the reference sigma (25%).
    uint64 public constant MAX_STEP_BPS = 2500;
    /// @notice Floor applied to a stock the admin has not configured (30%, mega-cap level).
    uint64 public constant DEFAULT_FLOOR_BPS = 3000;
    /// @notice A post may be valid for at most this long after it lands (2h on mainnet; deploy-time, bounded below).
    uint64 public immutable MAX_VALIDITY;
    uint64 public constant HARD_MIN_VALIDITY = 5 minutes;
    uint64 public constant HARD_MAX_VALIDITY = 2 hours;
    /// @notice Longest earnings buy-block window.
    uint64 public constant MAX_BUY_BLOCK = 3 days;
    /// @notice Upper bound for an admin floor (1000%), so a typo cannot freeze a name.
    uint64 public constant MAX_FLOOR_BPS = 100_000;

    /// @notice Minimum time between two accepted posts for one stock and speed (5 min on mainnet; deploy-time).
    uint64 public immutable MIN_POST_INTERVAL;
    uint64 public constant HARD_MIN_POST_INTERVAL = 30 seconds;
    uint64 public constant HARD_MAX_POST_INTERVAL = 1 hours;
    /// @notice Rolling window of the cumulative bound: HISTORY x MIN_POST_INTERVAL (1h on mainnet), so the ring of the
    /// last HISTORY posts always covers the window plus the value in force at its start.
    uint64 public immutable ROLLING_WINDOW;
    /// @notice Largest cumulative move inside any rolling window, in bps of the value at its start (50%).
    uint64 public constant MAX_WINDOW_MOVE_BPS = 5000;
    /// @notice Accepted posts kept per stock and speed (12 * 5 min = 1 h).
    uint256 public constant HISTORY = 12;

    /// @notice Largest skew coefficients (1e4 scale): k_put 3.0, k_call 1.0 (review F20).
    uint64 public constant MAX_SKEW_PUT = 30_000;
    uint64 public constant MAX_SKEW_CALL = 10_000;
    /// @notice Largest change of either skew coefficient per post (0.2 at 1e4 scale).
    uint64 public constant MAX_SKEW_STEP = 2_000;

    bytes32 public constant GUARDIAN_ROLE = Roles.GUARDIAN_ROLE;

    uint256 private constant BPS = 10_000;

    error InvalidAdmin();
    error SkewOutOfRange(uint64 skewK);
    error SkewStepTooLarge(uint64 prior, uint64 next);

    event SignerRevoked(address indexed signer);
    error InvalidSigner();
    error InvalidFloor(uint64 floorBps);
    error BadBuyBlockWindow(uint64 from, uint64 to);
    error RateLimited(uint64 nextAllowedAt);
    error WindowMoveTooLarge(uint64 anchorBps, uint64 next);
    error InvalidTimer();

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

    /// @dev Ring of the last HISTORY accepted posts (two entries per slot) and the next write index.
    struct Entry {
        uint64 at;
        uint64 sigmaBps;
    }

    struct History {
        Entry[12] ring;
        uint8 next;
    }

    address public signer;
    mapping(address stock => mapping(Speed speed => History)) private _history;
    mapping(address stock => mapping(Speed speed => Slot)) private _vol;
    mapping(address stock => Floor) private _floor;

    constructor(address admin, address signer_, uint64 maxValidity_, uint64 minPostInterval_)
        EIP712("LemniscateVolOracle", "1")
    {
        if (admin == address(0)) revert InvalidAdmin();
        if (
            maxValidity_ < HARD_MIN_VALIDITY || maxValidity_ > HARD_MAX_VALIDITY
                || minPostInterval_ < HARD_MIN_POST_INTERVAL || minPostInterval_ > HARD_MAX_POST_INTERVAL
        ) revert InvalidTimer();
        MAX_VALIDITY = maxValidity_;
        MIN_POST_INTERVAL = minPostInterval_;
        ROLLING_WINDOW = uint64(HISTORY) * minPostInterval_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
        _setSigner(signer_);
    }

    // ------------------------------------------------------------------ admin

    function setSigner(address signer_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _setSigner(signer_);
    }

    /// @notice Guardian: stop every post at once (a suspected signer compromise). Only the admin's timelocked
    /// `setSigner` restores posting.
    function revokeSigner() external onlyRole(GUARDIAN_ROLE) {
        emit SignerRevoked(signer);
        signer = address(0);
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

        _checkSkew(p.skewK, s.skewK, prior != 0);
        _checkAndRecordWindow(_history[p.stock][p.speed], p.sigmaBps, floor_, prior != 0);

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

    /// @notice The sigma range a post landing now would be allowed by the rolling-hour bound (before the 25% step
    /// and the floor), and the earliest time the rate limit allows the next post. lo = 0, hi = max when no history.
    function windowBounds(address stock, Speed speed)
        external
        view
        returns (uint64 lo, uint64 hi, uint64 nextAllowedAt)
    {
        History storage h = _history[stock][speed];
        uint64 floor_ = floorOf(stock);
        (uint64 minV, uint64 maxV, uint64 lastAt, bool any) = _windowRange(h, floor_);
        if (!any) return (0, type(uint64).max, 0);
        hi = uint64(Math.min(uint256(minV) * (BPS + MAX_WINDOW_MOVE_BPS) / BPS, type(uint64).max));
        lo = uint64(Math.ceilDiv(uint256(maxV) * (BPS - MAX_WINDOW_MOVE_BPS), BPS));
        nextAllowedAt = lastAt + MIN_POST_INTERVAL;
    }

    // ------------------------------------------------------------------ internal

    /// @dev Skew caps on every post, and the per-post step against the prior post's coefficients (review F20).
    function _checkSkew(uint64 skewK, uint64 priorSkew, bool hasPrior) private pure {
        uint64 kPut = skewK >> 32;
        uint64 kCall = skewK & 0xffffffff;
        if (kPut > MAX_SKEW_PUT || kCall > MAX_SKEW_CALL) revert SkewOutOfRange(skewK);
        if (!hasPrior) return;
        uint64 pPut = priorSkew >> 32;
        uint64 pCall = priorSkew & 0xffffffff;
        uint64 dPut = kPut > pPut ? kPut - pPut : pPut - kPut;
        uint64 dCall = kCall > pCall ? kCall - pCall : pCall - kCall;
        if (dPut > MAX_SKEW_STEP || dCall > MAX_SKEW_STEP) revert SkewStepTooLarge(priorSkew, skewK);
    }

    /// @dev Enforces the rate limit and the rolling-hour bound against the stored history, then appends `sigma`.
    function _checkAndRecordWindow(History storage h, uint64 sigma, uint64 floor_, bool hasPrior) private {
        if (hasPrior) {
            (uint64 minV, uint64 maxV, uint64 lastAt, bool any) = _windowRange(h, floor_);
            if (any) {
                if (block.timestamp < uint256(lastAt) + MIN_POST_INTERVAL) {
                    revert RateLimited(lastAt + MIN_POST_INTERVAL);
                }
                // sigma within +-50% of every value in force during the last hour.
                if (uint256(sigma) * BPS > uint256(minV) * (BPS + MAX_WINDOW_MOVE_BPS)) {
                    revert WindowMoveTooLarge(minV, sigma);
                }
                if (uint256(sigma) * BPS < uint256(maxV) * (BPS - MAX_WINDOW_MOVE_BPS)) {
                    revert WindowMoveTooLarge(maxV, sigma);
                }
            }
        }
        uint8 i = h.next;
        h.ring[i] = Entry({at: uint64(block.timestamp), sigmaBps: sigma});
        h.next = uint8((uint256(i) + 1) % HISTORY);
    }

    /// @dev Min and max sigma (each lifted to the floor) over the posts in force during [now - 1h, now]: every post
    /// newer than the window start plus the newest one at or before it (the value in force when the window opened).
    function _windowRange(History storage h, uint64 floor_)
        private
        view
        returns (uint64 minV, uint64 maxV, uint64 lastAt, bool any)
    {
        uint256 start = block.timestamp > ROLLING_WINDOW ? block.timestamp - ROLLING_WINDOW : 0;
        minV = type(uint64).max;
        uint256 idx = h.next;
        for (uint256 k; k < HISTORY; ++k) {
            idx = idx == 0 ? HISTORY - 1 : idx - 1; // newest first
            Entry memory e = h.ring[idx];
            if (e.at == 0) break; // never written
            if (!any) lastAt = e.at;
            any = true;
            uint64 v = e.sigmaBps < floor_ ? floor_ : e.sigmaBps;
            if (v < minV) minV = v;
            if (v > maxV) maxV = v;
            if (e.at <= start) break; // this one was in force at the window start; older ones are not
        }
    }

    function _setSigner(address signer_) private {
        if (signer_ == address(0)) revert InvalidSigner();
        signer = signer_;
        emit SignerSet(signer_);
    }
}
