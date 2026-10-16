// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IReserve} from "./interfaces/IReserve.sol";

/// @title Reserve
/// @notice First-loss layer of the Writer Pool (spec 2.6). The pool routes a share of its spread income here until the
/// balance reaches a target share of NAV. The pool counts the part of this balance needed to cover a drop below its
/// NAV-per-share high-water mark as its own ("reserve share"), so losses reach LP NAV only after the reserve is used up.
/// @dev USDG can only leave to the pool. There is no admin withdrawal: the reserve is not a treasury.
contract Reserve is AccessControl, IReserve {
    using SafeERC20 for IERC20;

    uint16 private constant MAX_INCOME_SHARE_BPS = 5_000;
    uint16 private constant MAX_TARGET_BPS = 2_500;

    IERC20 public immutable usdg;
    address public immutable override pool;

    uint16 public override incomeShareBps = 1_500;
    uint16 public override targetBps = 500;

    constructor(address admin, IERC20 usdg_, address pool_) {
        if (admin == address(0) || address(usdg_) == address(0) || pool_ == address(0)) revert InvalidParams();
        usdg = usdg_;
        pool = pool_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Pool only: sends up to `amountUsdg` to the pool to absorb a loss.
    function cover(uint256 amountUsdg) external override returns (uint256 sent) {
        if (msg.sender != pool) revert NotPool();
        uint256 bal = usdg.balanceOf(address(this));
        sent = amountUsdg < bal ? amountUsdg : bal;
        if (sent != 0) usdg.safeTransfer(pool, sent);
        emit Covered(amountUsdg, sent);
    }

    /// @notice Admin (timelock): income share and target, both in bps.
    function setParams(uint16 incomeShareBps_, uint16 targetBps_) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (incomeShareBps_ > MAX_INCOME_SHARE_BPS || targetBps_ > MAX_TARGET_BPS) revert InvalidParams();
        incomeShareBps = incomeShareBps_;
        targetBps = targetBps_;
        emit ParamsSet(incomeShareBps_, targetBps_);
    }

    function balance() external view override returns (uint256) {
        return usdg.balanceOf(address(this));
    }
}
