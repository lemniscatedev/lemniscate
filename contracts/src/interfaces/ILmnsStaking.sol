// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @dev $LMNS staking (spec 2.6, phase 2). The $LMNS token is issued by the launchpad, not by these contracts; the
/// staking contract takes its address at deploy. Staked $LMNS is the Writer Pool's second loss layer: after the
/// Reserve and before LP NAV, the pool may slash it pro rata (active stakes and stakes waiting out the unstake delay
/// alike), valued at a TWAP and capped by the stake. Stakers receive the FeeRouter's stakers bucket, streamed per
/// second staked. Staked amounts also set the holder's fee tier, which the engine reads with a safe default.
interface ILmnsStaking {
    event Staked(address indexed account, uint256 assets, uint256 shares);
    event UnstakeRequested(address indexed account, uint256 shares, uint64 readyAt);
    event UnstakeCancelled(address indexed account, uint256 shares);
    event Unstaked(address indexed account, uint256 shares, uint256 assets);
    event RewardsSynced(uint256 fresh, uint256 rewardRate, uint64 periodFinish);
    event RewardsClaimed(address indexed account, uint256 usdg);
    event Slashed(uint256 usdgRequested, uint256 lmnsSold, uint256 usdgSent);
    event SlashFailed(uint256 usdgRequested, uint256 lmnsOffered);
    event SlashRouteSet(address priceSource, address swapAdapter, uint24 poolFee, uint16 slippageBps);
    event TiersSet(uint256 count);

    error NotPool();
    error InvalidParams();
    error NothingToUnstake();
    error NotReady(uint64 readyAt);
    error ClaimTooEarly(uint64 claimableAt);

    struct Tier {
        uint128 minStake; // $LMNS (token units) of active stake
        uint16 feeDiscountBps; // share of the notional fee waived, in bps of the fee
        uint16 spreadDiscountBps; // share of the spread waived, in bps of the spread
    }

    /// @dev Pool only. Sells up to the USDG value of `usdgNeeded` of staked $LMNS (at the TWAP, with the slippage
    /// allowance, capped by the stake) and sends the USDG to the pool. Never reverts on a missing or failing route:
    /// returns 0 instead.
    function slash(uint256 usdgNeeded) external returns (uint256 usdgSent);
    /// @dev USDG (6 dp) the stake could cover now: stake x TWAP x (1 - slippage). Zero when no route is set.
    function coverValueUsdg() external view returns (uint256);
    /// @dev Fee and spread discounts (bps of each) for `account`'s active stake. Zero when no tier applies.
    function feeDiscountOf(address account) external view returns (uint16 feeDiscountBps, uint16 spreadDiscountBps);
    function pool() external view returns (address);
}
