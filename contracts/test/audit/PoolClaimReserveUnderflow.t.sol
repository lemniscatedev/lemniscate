// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PoolLayers} from "../../src/libs/PoolLayers.sol";
import {PoolHedging} from "../../src/libs/PoolHedging.sol";
import {IReserve} from "../../src/interfaces/IReserve.sol";
import {ILmnsStaking} from "../../src/interfaces/ILmnsStaking.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {IPriceReference} from "../../src/interfaces/IPriceReference.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";

contract CoverReserve {
    IERC20 internal immutable usdg;

    constructor(IERC20 u) {
        usdg = u;
    }

    function cover(uint256 amount) external returns (uint256 sent) {
        uint256 bal = usdg.balanceOf(address(this));
        sent = amount < bal ? amount : bal;
        usdg.transfer(msg.sender, sent);
    }
}

/// @dev Holds the pool-side storage the library settles against.
contract ClaimHarness {
    PoolLayers.Ticket internal t;
    PoolLayers.Pot internal pot;
    PoolHedging.Book internal b;

    function claim(IERC20 usdg, IReserve r, uint256 shares, PoolLayers.ClaimIn memory x)
        external
        returns (uint256 paid, uint256 burn)
    {
        t.owner = msg.sender;
        t.shares = shares;
        PoolHedging.Ctx memory c = PoolHedging.Ctx(usdg, IPriceGuard(address(0)), IPriceReference(address(0)), 100, 0);
        return PoolLayers.settleClaim(t, pot, b, c, r, ILmnsStaking(address(0)), x);
    }
}

/// @notice Audit 2026-10-29 L-1: after a gap loss that pushes raw NAV below zero but within the Reserve, the ticket's
/// reserve slice exceeds its value and `target - slice` panicked (0x11), freezing every LP exit.
contract PoolClaimReserveUnderflowTest is Test {
    function test_L1_claimWhenReserveSliceExceedsValuePays() public {
        MockUSDG usdg = new MockUSDG();
        CoverReserve r = new CoverReserve(IERC20(address(usdg)));
        usdg.mint(address(r), 1_000e6);
        ClaimHarness h = new ClaimHarness();
        PoolLayers.ClaimIn memory x = PoolLayers.ClaimIn({
            value: 100e6,
            liquid: 1_000e6,
            queuedValue: 100e6,
            queued: 1_000e12,
            reserveShareUsdg: 200e6,
            reserveBalUsdg: 1_000e6,
            supply: 1_000e12
        });
        (uint256 paid, uint256 burn) = h.claim(IERC20(address(usdg)), IReserve(address(r)), 1_000e12, x);
        assertEq(paid, 100e6, "exit pays its value");
        assertEq(burn, 1_000e12);
    }
}
