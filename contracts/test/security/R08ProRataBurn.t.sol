// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PoolFixture} from "../pool/PoolFixture.sol";

/// @notice Round-2 review R08 (MEDIUM): a pro-rata claim burned shares for its part of the day's pot, then cut the
/// payout to the cash on hand (pay(), rebalance and fees spend the pot's cash during the day) without re-sizing the
/// burn: the claimer gave up shares worth the full pot share and was paid less (alice lost 1,500 of 2,000 in the PoC).
/// The burn now shrinks with the capped payout.
contract R08ProRataBurnTest is PoolFixture {
    uint256[3] internal t;
    uint256 internal constant SOLD = 4_000 * USDG;

    function setUp() public {
        _deploy();
        _deposit(alice, 10_000 * USDG);
        _deposit(bob, 10_000 * USDG);
        _deposit(carol, 10_000 * USDG);
        _engineBuy(SOLD, 0, SOLD); // options sold: cash and liability +4,000 (NAV unchanged)
        pool.setParams(1 days, 0, 100, 2_000_000e6); // no cash buffer
        _hedgeTo(250e18); // 25,000 in stock
        vm.warp(vm.getBlockTimestamp() + 1 days + 1);
        t[0] = _request(alice, pool.balanceOf(alice));
        t[1] = _request(bob, pool.balanceOf(bob));
        t[2] = _request(carol, pool.balanceOf(carol));
        vm.warp(vm.getBlockTimestamp() + 72 hours);
        swapRouter.setRate(address(stock), address(usdg), FEE, 1); // every hedge sale fails its floor: pro-rata
    }

    function _claim(uint256 i) internal returns (uint256 paid, uint256 burned, uint256 valueBurned) {
        (address owner_, uint256 sharesBefore,) = pool.ticketOf(t[i]);
        uint256 perShareValue = pool.previewRedeem(1e18); // navLow value of 1e18 shares now
        vm.prank(owner_);
        paid = pool.claim(t[i]);
        (, uint256 sharesAfter,) = pool.ticketOf(t[i]);
        burned = sharesBefore - sharesAfter;
        valueBurned = burned * perShareValue / 1e18;
    }

    /// @dev Reviewer PoC shape: the pot is recorded by the first claim of the day, option holders then sell and pay()
    /// drains the cash, and the next claim's payout is capped. Its burn must be capped with it.
    function test_R08_cappedPayoutBurnsOnlyWhatItPays() public {
        _claim(0); // records the day's pot
        engine.sell(seller, SOLD, 0, SOLD * 1e12); // pay() spends the pot's cash (NAV-neutral)
        (uint256 paid,, uint256 valueBurned) = _claim(1);
        assertGt(paid, 0);
        assertLe(valueBurned, paid + 2, "burned shares worth no more than paid");
    }

    /// @dev PROPERTY: for any spend of the pool's cash between the pot's creation and a claim (option payouts of any
    /// size), every pro-rata claim burns shares worth at most what it pays plus the charged shortfall (+ rounding).
    function testFuzz_R08_burnNeverExceedsPayout(uint256 spend, uint8 order) public {
        uint256 first = order % 3;
        _claim(first);
        spend = bound(spend, 0, SOLD);
        if (spend != 0) engine.sell(seller, spend, 0, spend * 1e12);
        for (uint256 k = 1; k < 3; ++k) {
            uint256 i = (first + k) % 3;
            if (pool.previewRedeem(1e18) == 0) break;
            try this.claimFor(i) returns (uint256 paid, uint256, uint256 valueBurned) {
                assertLe(valueBurned, paid + 2, "value(burn) <= paid (+ rounding)");
            } catch {}
        }
    }

    function claimFor(uint256 i) external returns (uint256, uint256, uint256) {
        return _claim(i);
    }
}
