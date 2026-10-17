// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {VaultFixture} from "./VaultFixture.sol";
import {WriterVault} from "../../src/vaults/WriterVault.sol";
import {CoveredUpVault} from "../../src/vaults/CoveredUpVault.sol";
import {CashDownVault} from "../../src/vaults/CashDownVault.sol";
import {IWriterVault, IVaultRegistry} from "../../src/interfaces/IWriterVault.sol";
import {IPool} from "../../src/interfaces/IPool.sol";

/// @notice Todo 19 rules R1-R6 on the real engine, pool, fee router and PriceGuard (R7 invariants: VaultInvariant).
contract WriterVaultTest is VaultFixture {
    uint128 internal constant K_CALL = 120e18;
    uint128 internal constant K_PUT = 80e18;

    function setUp() public {
        _deployVaults();
    }

    // ------------------------------------------------------------------------------------------- helpers

    /// @dev Bob funds both vaults, the epoch rolls, then fresh Weekly series are listed and bought (norm exactly 1e18).
    function _funded(uint256 callColl, uint256 putColl, uint256 boughtUnits) internal returns (bytes32 c, bytes32 p) {
        _open();
        if (callColl != 0) _vdeposit(up, bob, callColl);
        if (putColl != 0) _vdeposit(down, bob, putColl);
        _roll(up);
        if (vm.getBlockTimestamp() < down.epochEndsAt()) vm.warp(down.epochEndsAt());
        down.roll();
        if (callColl != 0) _claim(up, bob);
        if (putColl != 0) _claim(down, bob);
        _fresh();
        c = _list(0, true, K_CALL, WEEKLY);
        p = _list(0, false, K_PUT, WEEKLY);
        _buy(alice, c, boughtUnits);
        _buy(alice, p, boughtUnits);
    }

    function _logAmount(Vm.Log[] memory logs, bytes32 sig) internal pure returns (uint256 amount, bool found) {
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics.length != 0 && logs[i].topics[0] == sig) {
                (amount, found) = (abi.decode(logs[i].data, (uint256)), true);
            }
        }
    }

    // ----------------------------------------------------------------------------- R1 collateralExact

    function test_R1_collateralExact_calls() public {
        (bytes32 c,) = _funded(10e18, 0, 30e18);
        assertEq(registry.seriesOf(c).norm, 1e18);
        assertEq(up.collateral(), 10e18);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IVaultRegistry.InsufficientCollateral.selector, 10e18, 10e18 + 1));
        vreg.assume(address(up), c, 10e18 + 1);
        _assume(up, c, 10e18);
        assertEq(vreg.lockedOf(address(up)), 10e18, "one raw Stock Token unit per call unit");
        assertEq(up.freeCollateral(), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IVaultRegistry.InsufficientCollateral.selector, 0, 1));
        vreg.assume(address(up), c, 1);
    }

    function test_R1_collateralExact_puts() public {
        (, bytes32 p) = _funded(0, 800e6, 30e18);
        _assume(down, p, 10e18);
        assertEq(vreg.lockedOf(address(down)), 800e6, "strike x units in USDG");
        assertEq(vreg.requiredFor(p, 1e18), 80e6);
        assertEq(down.freeCollateral(), 0);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IVaultRegistry.InsufficientCollateral.selector, 0, 1));
        vreg.assume(address(down), p, 1);
    }

    function test_R1_pendingDepositsAreNotWritable() public {
        _open();
        _fresh();
        bytes32 c = _list(0, true, K_CALL, WEEKLY);
        _buy(alice, c, 10e18);
        _vdeposit(up, bob, 10e18);
        assertEq(up.collateral(), 0);
        assertEq(up.pendingAssets(), 10e18);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IVaultRegistry.InsufficientCollateral.selector, 0, 1e18));
        vreg.assume(address(up), c, 1e18);
    }

    function test_R1_bandSupplyAndSide() public {
        (bytes32 c, bytes32 p) = _funded(100e18, 100_000e6, 10e18);
        // supply bound
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IVaultRegistry.ExceedsSupply.selector, c));
        vreg.assume(address(up), c, 10e18 + 1);
        // wrong side
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IVaultRegistry.OutOfBand.selector, p));
        vreg.assume(address(up), p, 1e18);
        // in the money / outside the band
        bytes32 itm = _list(0, true, 90e18, WEEKLY);
        bytes32 far = _list(0, true, 160e18, WEEKLY);
        bytes32 itmPut = _list(0, false, 110e18, WEEKLY);
        _buy(alice, itm, 1e18);
        _buy(alice, far, 1e18);
        _buy(alice, itmPut, 1e18);
        vm.startPrank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IVaultRegistry.OutOfBand.selector, itm));
        vreg.assume(address(up), itm, 1e17);
        vm.expectRevert(abi.encodeWithSelector(IVaultRegistry.OutOfBand.selector, far));
        vreg.assume(address(up), far, 1e17);
        vm.expectRevert(abi.encodeWithSelector(IVaultRegistry.OutOfBand.selector, itmPut));
        vreg.assume(address(down), itmPut, 1e17);
        vm.stopPrank();
        // wrong speed
        bytes32 daily = _list(0, true, K_CALL, DAILY);
        _buy(alice, daily, 1e18);
        vm.prank(keeper);
        vm.expectRevert(abi.encodeWithSelector(IVaultRegistry.OutOfBand.selector, daily));
        vreg.assume(address(up), daily, 1e17);
        // only the allocator
        vm.prank(alice);
        vm.expectRevert();
        vreg.assume(address(up), c, 1e17);
    }

    function test_R1_slicesShrinkWithFundingAndFreeCollateral() public {
        (bytes32 c,) = _funded(10e18, 0, 10e18);
        _assume(up, c, 10e18);
        assertEq(up.freeCollateral(), 0);
        skip(1 days);
        _fresh();
        uint128 norm = registry.seriesOf(c).norm;
        assertLt(norm, 1e18);
        uint256 units = (uint256(10e18) * norm + 1e18 - 1) / 1e18;
        assertEq(vreg.lockedOf(address(up)), units);
        assertEq(up.freeCollateral(), 10e18 - units);
    }

    // ------------------------------------------------------------ R3 lossEventTransfersAtOracleValue

    function test_R3_callBuybackPaysStockAtOracleValue() public {
        (bytes32 c,) = _funded(10e18, 0, 30e18);
        _assume(up, c, 10e18);
        uint256 navBefore = up.nav();
        assertApproxEqAbs(navBefore, 1000e18 + up.fundingReceived() * 1e12, 1);
        _setPrice(0, 125e18);
        _setPrice(0, 150e18);
        _refreshVols();
        uint256 poolUnits = pool.hedgeUnits(address(stocks[0]));
        uint256 poolBal = stocks[0].balanceOf(address(pool));
        uint256 tokens = _token(c).balanceOf(alice);
        _sell(alice, c, tokens);
        // slice = 1/3 of supply; intrinsic (150 - 120) / 150 of 10 units = 2 Stock Tokens.
        uint256 loss = 2e18;
        assertEq(up.collateral(), 10e18 - loss, "vault paid the slice's intrinsic value in Stock Tokens");
        assertEq(stocks[0].balanceOf(address(pool)) - poolBal, loss, "pool received the Stock Tokens");
        assertEq(pool.hedgeUnits(address(stocks[0])) - poolUnits, loss, "pool hedge book tracks them");
        assertEq(vreg.coveredTokens(c), 0);
        assertEq(vreg.lockedOf(address(up)), 0);
        // NAV: collateral at S plus funding received; the move from 100 to 150 lost exactly loss x S vs unhedged.
        assertEq(up.nav(), (10e18 - loss) * 150 + up.fundingReceived() * 1e12);
        assertLt(up.nav(), 10e18 * 150 + up.fundingReceived() * 1e12);
    }

    function test_R3_putBuybackPaysUsdgAtOracleValue() public {
        (, bytes32 p) = _funded(0, 800e6, 30e18);
        _assume(down, p, 10e18);
        uint256 collBefore = down.collateral();
        _setPrice(0, 75e18);
        _setPrice(0, 60e18);
        _refreshVols();
        uint256 tokens = _token(p).balanceOf(alice);
        vm.recordLogs();
        _sell(alice, p, tokens);
        (uint256 spreadNet,) = _logAmount(vm.getRecordedLogs(), IPool.VaultFundingPaid.selector);
        // intrinsic (80 - 60) x 10 units = 200 USDG.
        assertEq(down.collateral(), collBefore - 200e6 + spreadNet);
        assertEq(down.nav(), down.collateral() * 1e12);
        assertEq(vreg.coveredTokens(p), 0);
    }

    function test_R3_partialBuybackIsProRata() public {
        (bytes32 c,) = _funded(10e18, 0, 30e18);
        _assume(up, c, 10e18);
        _setPrice(0, 125e18);
        _setPrice(0, 150e18);
        _refreshVols();
        _sell(alice, c, 15e18); // half the supply: half the slice closes
        assertEq(vreg.coveredTokens(c), 5e18);
        assertEq(up.collateral(), 9e18);
        assertEq(vreg.lockedOf(address(up)), 5e18);
    }

    function test_R3_otmBuybackPaysNothing() public {
        (bytes32 c,) = _funded(10e18, 0, 30e18);
        _assume(up, c, 10e18);
        _sell(alice, c, 30e18);
        assertEq(up.collateral(), 10e18);
        assertEq(vreg.coveredTokens(c), 0);
    }

    function test_R3_queuedSellFillSettlesVault() public {
        (bytes32 c,) = _funded(10e18, 0, 30e18);
        _assume(up, c, 10e18);
        skip(27 hours); // feed older than its max age in a live session: HALTED, the sell is escrowed
        _refreshVols();
        uint256 tokens = _token(c).balanceOf(alice);
        _sell(alice, c, tokens);
        assertEq(vreg.coveredTokens(c), 10e18, "escrow keeps the slice");
        _setPrice(0, 125e18);
        _setPrice(0, 150e18);
        engine.fillQueued(1);
        assertEq(vreg.coveredTokens(c), 0);
        uint256 units = _units(c, 10e18);
        assertApproxEqAbs(10e18 - up.collateral(), units / 5, 2, "intrinsic 30/150 of the slice");
    }

    function test_R3_releaseSettlesIntrinsic() public {
        (bytes32 c,) = _funded(10e18, 0, 30e18);
        _assume(up, c, 10e18);
        _setPrice(0, 125e18);
        _setPrice(0, 150e18);
        vm.prank(keeper);
        uint256 loss = vreg.release(address(up), c, 10e18);
        assertEq(loss, 2e18);
        assertEq(up.collateral(), 8e18);
    }

    function test_R3_failedPayoutBecomesDebtAndIsSettled() public {
        (, bytes32 p) = _funded(0, 800e6, 30e18);
        _assume(down, p, 10e18);
        _setPrice(0, 75e18);
        _setPrice(0, 60e18);
        usdg.setBlocked(address(down), true); // issuer freezes the vault
        uint256 poolCash = usdg.balanceOf(address(pool));
        vm.prank(keeper);
        vreg.release(address(down), p, 10e18);
        assertEq(down.debt(), 200e6);
        assertEq(down.collateral(), 600e6);
        assertEq(usdg.balanceOf(address(pool)), poolCash);
        usdg.setBlocked(address(down), false);
        down.settleDebt();
        assertEq(down.debt(), 0);
        assertEq(usdg.balanceOf(address(pool)), poolCash + 200e6);
    }

    // --------------------------------------------------------------------------------- R4 epochAccounting

    function test_R4_epochAccounting() public {
        (, bytes32 p) = _funded(0, 1000e6, 20e18);
        uint256 bobShares = down.balanceOf(bob);
        assertEq(bobShares, 1000e6 * 1e12, "first deposit: 1e18 shares per USDG");
        _assume(down, p, 10e18);

        // Carol deposits during epoch 1: pending, not writable, earns nothing in epoch 1.
        _vdeposit(down, carol, 1000e6);
        assertEq(down.pendingAssets(), 1000e6);
        uint256 coll0 = down.collateral();
        vm.warp(down.epochEndsAt());
        _fresh();
        uint256 f = down.collateral() - coll0;
        assertGt(f, 0, "funding received during epoch 1");
        assertEq(down.pendingAssets(), 1000e6, "pending deposits receive nothing");

        down.roll();
        _claim(down, carol);
        uint256 nps = down.navPerShare();
        uint256 carolValue = down.balanceOf(carol) * nps / 1e18 / 1e12;
        uint256 bobValue = bobShares * nps / 1e18 / 1e12;
        assertApproxEqAbs(carolValue, 1000e6, 1, "carol enters at NAV, earns from epoch 2");
        assertApproxEqAbs(bobValue, 1000e6 + f, 1, "bob keeps epoch 1's funding");

        // Bob leaves in epoch 2 while his slice is locked, the vault is closed and the price is stale: honoured.
        vm.prank(admin);
        down.setOpen(false);
        vm.prank(bob);
        down.requestWithdraw(bobShares);
        vm.warp(down.epochEndsAt() + 3 days); // no fresh feed round: stale price
        vm.expectEmit(true, false, false, false, address(down));
        emit IWriterVault.EpochRolled(2, 0, 0, 0, 0, 0, 0);
        down.roll();
        (, uint256 out,) = _claim(down, bob);
        assertApproxEqAbs(out, 1000e6 + f, 2, "pro rata at epoch end");
        assertEq(down.balanceOf(bob), 0);
        assertLe(vreg.lockedOf(address(down)), down.collateral(), "what stays still covers what stays");
        assertGt(down.nav(), 0);
    }

    function test_R4_withdrawalNeverBlocked_poolFrozenAndItm() public {
        (, bytes32 p) = _funded(0, 800e6, 30e18);
        _assume(down, p, 10e18);
        _setPrice(0, 75e18);
        _setPrice(0, 60e18);
        uint256 shares = down.balanceOf(bob);
        vm.prank(bob);
        down.requestWithdraw(shares);
        usdg.setBlocked(address(pool), true); // the loss payment to the pool cannot move
        _roll(down);
        uint256 units = (uint256(10e18) * registry.seriesOf(p).norm + 1e18 - 1) / 1e18;
        uint256 loss = (units * 20e18 + 1e30 - 1) / 1e30; // (80 - 60) x units, rounded up
        assertEq(down.debt(), loss);
        (, uint256 out,) = _claim(down, bob);
        assertApproxEqAbs(out, 800e6 - loss, 2, "collateral less the slice's intrinsic value");
        assertEq(down.totalSupply(), 0);
        usdg.setBlocked(address(pool), false);
        down.settleDebt();
        assertEq(down.debt(), 0);
    }

    function test_R4_rollOnlyAfterEpoch() public {
        vm.expectRevert(abi.encodeWithSelector(IWriterVault.EpochNotOver.selector, up.epochEndsAt()));
        up.roll();
        skip(EPOCH);
        up.roll();
        assertEq(up.currentEpoch(), 1);
    }

    function test_R4_epochTimerHardBounds() public {
        WriterVault.Params memory p = _params(true);
        p.epoch = 5 minutes - 1;
        vm.expectRevert(IWriterVault.InvalidParams.selector);
        new CoveredUpVault(p);
        p.epoch = 30 days + 1;
        vm.expectRevert(IWriterVault.InvalidParams.selector);
        new CoveredUpVault(p);
        p.epoch = 5 minutes;
        assertEq(new CoveredUpVault(p).EPOCH(), 5 minutes);
        assertEq(up.EPOCH(), 7 days);
        // bands are out of the money only
        p.minMoneynessBps = 9_999;
        vm.expectRevert(IWriterVault.InvalidParams.selector);
        new CoveredUpVault(p);
        WriterVault.Params memory q = _params(false);
        q.maxMoneynessBps = 10_001;
        vm.expectRevert(IWriterVault.InvalidParams.selector);
        new CashDownVault(q);
    }

    // ------------------------------------------------------------------------------------ R5 fundingShare

    function test_R5_spreadShareConservation() public {
        (, bytes32 p) = _funded(0, 1000e6, 20e18);
        _assume(down, p, 10e18); // half the supply
        uint256 coll = down.collateral();
        uint256 poolCash = usdg.balanceOf(address(pool));
        uint256 routerBal = usdg.balanceOf(address(fees));
        uint256 reserveBal = usdg.balanceOf(address(reserve));
        uint256 aliceBal = usdg.balanceOf(alice);
        vm.recordLogs();
        _buy(alice, p, 10e18);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        uint256 cost = aliceBal - usdg.balanceOf(alice);
        uint256 spread;
        for (uint256 i; i < logs.length; ++i) {
            if (logs[i].topics[0] == IPool.SaleRecorded.selector) (, spread) = abi.decode(logs[i].data, (uint256, uint256));
        }
        assertGt(spread, 0);
        uint256 gross = spread * 10e18 / 20e18;
        uint256 net = gross - gross * 1_000 / 10_000;
        assertEq(down.collateral() - coll, net, "90% of the slice's spread share");
        uint256 toVault = down.collateral() - coll;
        uint256 toRouter = usdg.balanceOf(address(fees)) - routerBal;
        uint256 toReserve = usdg.balanceOf(address(reserve)) - reserveBal;
        assertEq(usdg.balanceOf(address(pool)) - poolCash + toRouter + toReserve + toVault, cost, "conservation");
        assertEq(toRouter, spread * 1_000 / 10_000, "protocol fee on the whole spread");
        assertEq(usdg.balanceOf(address(vreg)), 0);
    }

    function test_R5_fundingShareConservation() public {
        (bytes32 c,) = _funded(10e18, 0, 40e18);
        _assume(up, c, 10e18); // a quarter of the supply
        skip(6 hours);
        _setPrice(0, px[0]);
        _refreshVols();
        uint256 poolCash = usdg.balanceOf(address(pool));
        uint256 routerBal = usdg.balanceOf(address(fees));
        vm.recordLogs();
        engine.accrue(c);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        (uint256 funding, bool found) = _logAmount(logs, IPool.FundingRecorded.selector);
        assertTrue(found);
        (uint256 paid,) = _logAmount(logs, IPool.VaultFundingPaid.selector);
        uint256 gross = funding * 10e18 / 40e18;
        assertEq(paid, gross - gross * 1_000 / 10_000, "90% of the slice's funding share");
        assertEq(up.fundingReceived(), paid);
        uint256 toRouter = usdg.balanceOf(address(fees)) - routerBal;
        assertEq(toRouter, funding * 1_000 / 10_000);
        assertEq(poolCash - usdg.balanceOf(address(pool)), toRouter + paid, "conservation (funding is in kind)");
    }

    function test_R5_noHookNoChange() public {
        vm.prank(admin);
        pool.setVaultHook(address(0));
        (bytes32 c,) = _funded(10e18, 0, 10e18);
        vm.prank(keeper);
        vreg.assume(address(up), c, 10e18); // the book exists, but the pool no longer routes to it
        skip(6 hours);
        _fresh();
        assertEq(up.fundingReceived(), 0);
    }

    function test_R5_hookChecks() public {
        vm.prank(admin);
        vm.expectRevert(); // a registry for another pool
        pool.setVaultHook(address(up));
        vm.expectRevert(IPool.NotVaultHook.selector);
        pool.creditVaultStock(address(stocks[0]), 1);
        vm.expectRevert(IPool.NotEngine.selector);
        pool.onBuyback(bytes32(0), 1, 1, 1, 1);
        vm.expectRevert(IVaultRegistry.NotPool.selector);
        vreg.routeFunding(bytes32(0), 1);
        vm.expectRevert(IVaultRegistry.NotPool.selector);
        vreg.onBuyback(bytes32(0), 1, 1, 1);
        vm.expectRevert(IVaultRegistry.NotVault.selector);
        vreg.releaseFraction(1);
        vm.expectRevert(IWriterVault.NotRegistry.selector);
        up.payLoss(alice, 1);
        vm.expectRevert(IWriterVault.NotRegistry.selector);
        up.creditFunding(1);
    }

    // ---------------------------------------------------------------------------------- R6 closedByDefault

    function test_R6_closedByDefault() public {
        assertFalse(up.open());
        assertFalse(down.open());
        stocks[0].mint(bob, 1e18);
        vm.startPrank(bob);
        stocks[0].approve(address(up), 1e18);
        vm.expectRevert(IWriterVault.VaultClosed.selector);
        up.deposit(1e18);
        vm.stopPrank();
    }

    function test_R6_closedBlocksDepositsOnly() public {
        _open();
        _vdeposit(up, bob, 5e18);
        _roll(up);
        vm.prank(guardian);
        up.setOpen(false);
        // withdrawals, rolls and claims keep working while closed
        vm.startPrank(bob);
        up.claim();
        up.requestWithdraw(up.balanceOf(bob));
        vm.stopPrank();
        _roll(up);
        (, uint256 out,) = _claim(up, bob);
        assertEq(out, 5e18);
        // the guardian can close but never open
        bytes32 role = up.GUARDIAN_ROLE();
        vm.prank(guardian);
        vm.expectRevert(abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, guardian, role));
        up.setOpen(true);
    }

    function test_R6_minimumDeposit() public {
        _open();
        stocks[0].mint(bob, 1e15);
        vm.startPrank(bob);
        stocks[0].approve(address(up), 1e15);
        vm.expectRevert(IWriterVault.BelowMinimum.selector);
        up.deposit(1e15 - 1);
        up.deposit(1e15);
        vm.stopPrank();
    }

    function test_R7_donationDoesNotMoveSharePrice() public {
        _open();
        _vdeposit(down, bob, 1000e6);
        _roll(down);
        _claim(down, bob);
        uint256 nps = down.navPerShare();
        usdg.mint(address(down), 1_000_000e6); // donation
        assertEq(down.navPerShare(), nps);
        _vdeposit(down, carol, 1000e6);
        _roll(down);
        _claim(down, carol);
        assertEq(down.balanceOf(carol), down.balanceOf(bob));
    }
}
