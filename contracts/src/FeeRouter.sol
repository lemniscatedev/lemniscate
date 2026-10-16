// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IFeeRouter} from "./interfaces/IFeeRouter.sol";

/// @title FeeRouter
/// @notice Collects the protocol fee (a share of the Writer Pool's spread and funding income) and splits it weekly:
/// 80% workers (pool writers through NAV, keepers pot, hedger pot), 10% treasury, 5% stakers, 5% burn. Stakers and
/// burn have no recipient until phase 2; their buckets are held here and paid out once a recipient is set.
/// @dev The amount split is the router's USDG balance minus held buckets, so anyone may top it up and rounding dust
/// simply rolls into the next distribution. Admin is the timelock.
contract FeeRouter is AccessControl, IFeeRouter {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;
    /// @notice Time between two distributions, fixed per deployment (7 days on mainnet and fork, minutes on testnet).
    uint256 public immutable PERIOD;
    uint256 public constant MIN_PERIOD = 5 minutes;
    uint256 public constant MAX_PERIOD = 30 days;
    uint16 private constant MAX_PROTOCOL_FEE_BPS = 3_000;

    bytes32 private constant BUCKET_KEEPERS = "keepers";
    bytes32 private constant BUCKET_HEDGER = "hedger";
    bytes32 private constant BUCKET_TREASURY = "treasury";
    bytes32 private constant BUCKET_STAKERS = "stakers";
    bytes32 private constant BUCKET_BURN = "burn";

    IERC20 public immutable usdg;
    address public immutable pool;

    address public treasury;
    address public keepersPot;
    address public hedgerPot;
    address public stakers; // phase 2 (first-loss stakers); zero = held
    address public burnVault; // phase 2 (token burn); zero = held

    uint16 public override protocolFeeBps = 1_000;
    uint16 public workersBps = 8_000;
    uint16 public treasuryBps = 1_000;
    uint16 public stakersBps = 500;
    uint16 public burnBps = 500;
    uint16 public workerPoolBps = 6_000;
    uint16 public workerKeepersBps = 2_000;
    uint16 public workerHedgerBps = 2_000;

    uint256 public lastDistribution;
    mapping(bytes32 bucket => uint256 usdg) public held;

    constructor(address admin, IERC20 usdg_, address pool_, address treasury_, uint256 period_) {
        if (admin == address(0) || address(usdg_) == address(0) || pool_ == address(0) || treasury_ == address(0)) {
            revert InvalidParams();
        }
        if (period_ < MIN_PERIOD || period_ > MAX_PERIOD) revert InvalidParams();
        PERIOD = period_;
        usdg = usdg_;
        pool = pool_;
        treasury = treasury_;
        lastDistribution = block.timestamp;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Splits everything not held, at most once per PERIOD.
    function distribute() external override returns (uint256 amount) {
        uint256 next = lastDistribution + PERIOD;
        if (block.timestamp < next) revert TooEarly(next);
        lastDistribution = block.timestamp;
        amount = distributable();

        uint256 workers = amount * workersBps / BPS;
        uint256 toPool = workers * workerPoolBps / BPS;
        uint256 toKeepers = workers * workerKeepersBps / BPS;
        uint256 toHedger = workers * workerHedgerBps / BPS;
        uint256 toTreasury = amount * treasuryBps / BPS;
        uint256 toStakers = amount * stakersBps / BPS;
        uint256 toBurn = amount * burnBps / BPS;

        if (toPool != 0) usdg.safeTransfer(pool, toPool);
        _pay(BUCKET_KEEPERS, keepersPot, toKeepers);
        _pay(BUCKET_HEDGER, hedgerPot, toHedger);
        _pay(BUCKET_TREASURY, treasury, toTreasury);
        _pay(BUCKET_STAKERS, stakers, toStakers);
        _pay(BUCKET_BURN, burnVault, toBurn);
        emit Distributed(amount, toPool, toKeepers, toHedger, toTreasury, toStakers, toBurn);
    }

    function distributable() public view override returns (uint256) {
        uint256 bal = usdg.balanceOf(address(this));
        uint256 h = _totalHeld();
        return bal > h ? bal - h : 0;
    }

    function nextDistributionAt() external view override returns (uint256) {
        return lastDistribution + PERIOD;
    }

    function heldStakers() external view override returns (uint256) {
        return held[BUCKET_STAKERS];
    }

    function heldBurn() external view override returns (uint256) {
        return held[BUCKET_BURN];
    }

    // ---- admin (timelock)

    function setProtocolFeeBps(uint16 bps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bps > MAX_PROTOCOL_FEE_BPS) revert InvalidParams();
        protocolFeeBps = bps;
        emit ProtocolFeeSet(bps);
    }

    function setSplit(uint16 workers, uint16 treasury_, uint16 stakers_, uint16 burn) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (uint256(workers) + treasury_ + stakers_ + burn != BPS) revert InvalidParams();
        (workersBps, treasuryBps, stakersBps, burnBps) = (workers, treasury_, stakers_, burn);
        emit SplitSet(workers, treasury_, stakers_, burn);
    }

    function setWorkerSplit(uint16 poolBps, uint16 keepersBps, uint16 hedgerBps) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (uint256(poolBps) + keepersBps + hedgerBps != BPS) revert InvalidParams();
        (workerPoolBps, workerKeepersBps, workerHedgerBps) = (poolBps, keepersBps, hedgerBps);
        emit WorkerSplitSet(poolBps, keepersBps, hedgerBps);
    }

    /// @notice Sets a bucket's recipient ("keepers", "hedger", "treasury", "stakers", "burn"). Zero holds the bucket.
    function setRecipient(bytes32 bucket, address recipient) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (bucket == BUCKET_KEEPERS) keepersPot = recipient;
        else if (bucket == BUCKET_HEDGER) hedgerPot = recipient;
        else if (bucket == BUCKET_STAKERS) stakers = recipient;
        else if (bucket == BUCKET_BURN) burnVault = recipient;
        else if (bucket == BUCKET_TREASURY && recipient != address(0)) treasury = recipient;
        else revert InvalidParams();
        emit RecipientSet(bucket, recipient);
    }

    function _pay(bytes32 bucket, address to, uint256 amount) private {
        if (to == address(0)) {
            if (amount != 0) {
                held[bucket] += amount;
                emit Held(bucket, amount);
            }
            return;
        }
        uint256 total = amount + held[bucket];
        held[bucket] = 0;
        if (total != 0) usdg.safeTransfer(to, total);
    }

    function _totalHeld() private view returns (uint256) {
        return held[BUCKET_KEEPERS] + held[BUCKET_HEDGER] + held[BUCKET_TREASURY] + held[BUCKET_STAKERS]
            + held[BUCKET_BURN];
    }
}
