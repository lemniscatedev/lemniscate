// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {EngineBase} from "../engine/EngineBase.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";

/// @notice Review findings F01/F02 (HIGH, PERP-3): buys and sells filled in the same transaction at a feed that lags
/// the market by up to 0.5%, so buying before a deviation print and selling after it paid ~21-28% of a Daily ATM
/// premium per round trip. These are the reviewers' round trips; each must now lose money.
contract F01TradePriceTest is EngineBase {
    uint256 internal constant UNITS = 10_000e18;

    /// @dev Reviewer F01: NVDA trades 100.45 while the feed says 100.00 (the pool's 5-minute TWAP reads 100.30); buy
    /// the Daily ATM call, the feed prints 100.50 a minute later, sell.
    function test_F01_buyBeforePrintSellAfterLoses() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        guard.setTradeTwap(address(nvda), 100.3e18);
        (uint256 cost, uint256 tokens) = _buy(alice, id, UNITS);

        skip(60);
        guard.setS(address(nvda), 100.5e18);
        guard.setTradeTwap(address(nvda), 100.45e18);
        uint256 proceeds = _sell(alice, id, tokens);
        assertLt(proceeds, cost, "round trip around a print must lose");
    }

    /// @dev Reviewer F02, put side: the market is 0.3% under the feed, buy the put, the feed prints -0.5%, sell.
    function test_F02_putRoundTripAroundDownPrintLoses() public {
        bytes32 id = _list(address(nvda), false, 100e18, DAILY);
        guard.setTradeTwap(address(nvda), 99.7e18);
        (uint256 cost, uint256 tokens) = _buy(alice, id, UNITS);

        skip(60);
        guard.setS(address(nvda), 99.5e18);
        guard.setTradeTwap(address(nvda), 99.55e18);
        uint256 proceeds = _sell(alice, id, tokens);
        assertLt(proceeds, cost, "put round trip around a print must lose");
    }

    /// @dev The minimum hold cannot be stepped around by moving the tokens to a fresh address: held tokens cannot be
    /// transferred until the hold ends (review R02, which replaced the hold hand-over a stranger could abuse).
    function test_F01_transferDoesNotEscapeTheHold() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        guard.setTradeTwap(address(nvda), 100.3e18);
        (, uint256 tokens) = _buy(alice, id, UNITS);

        IERC20 token = _token(id);
        uint64 until = uint64(vm.getBlockTimestamp() + 30 minutes);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.HeldTokens.selector, until));
        token.transfer(bob, tokens);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(IOptionEngine.HeldTokens.selector, until));
        token.transfer(bob, 1);
        skip(30 minutes);
        vm.prank(alice);
        token.transfer(bob, tokens); // free once the hold ends
        assertEq(token.balanceOf(bob), tokens);
    }
}
