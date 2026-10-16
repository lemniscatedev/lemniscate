// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SystemFixture} from "./SystemFixture.sol";
import {SystemHandler} from "./SystemHandler.sol";
import {MockGuardFeed} from "../mocks/PriceGuardMocks.sol";

/// @notice Todo 07b R4 (systemInvariants): the REAL engine and REAL Writer Pool (with Reserve and FeeRouter), the
/// real SeriesRegistry, PriceGuard and VolOracle over mock feeds, driven by traders, LPs, the keeper, the hedger,
/// ordinary moves, 25% gaps, session changes and time (SystemHandler).
/// Deep run: `FOUNDRY_PROFILE=deep forge test --match-contract SystemInvariantTest`.
contract SystemInvariantTest is SystemFixture {
    SystemHandler internal handler;
    address[] internal traders;
    address[] internal lps;
    address[] internal holders; // every USDG holder

    function setUp() public {
        _deploySystem(3, 5_000_000e6);
        address[] memory ss = new address[](stocks.length);
        bytes32[] memory ids = new bytes32[](4 * stocks.length);
        for (uint256 i; i < stocks.length; ++i) {
            ss[i] = address(stocks[i]);
            ids[4 * i] = _list(i, true, uint128(px[i]), DAILY);
            ids[4 * i + 1] = _list(i, false, uint128(px[i]), DAILY);
            ids[4 * i + 2] = _list(i, false, uint128(px[i] * 90 / 100), WEEKLY);
            ids[4 * i + 3] = _list(i, true, uint128(px[i] * 110 / 100), WEEKLY);
        }
        traders.push(alice);
        traders.push(makeAddr("bob"));
        traders.push(makeAddr("carol"));
        lps.push(lp);
        lps.push(makeAddr("lp2"));

        handler = new SystemHandler(engine, pool, registry, vol, guard, hours_, router, IERC20(address(usdg)), hedger);
        MockGuardFeed[] memory fs = new MockGuardFeed[](feeds.length);
        for (uint256 i; i < feeds.length; ++i) {
            fs[i] = feeds[i];
        }
        handler.init(ss, fs, px, ids, traders, lps, nonce);
        address guardian = makeAddr("guardian");
        vm.startPrank(admin);
        engine.grantRole(engine.GUARDIAN_ROLE(), guardian);
        pool.grantRole(pool.GUARDIAN_ROLE(), guardian);
        guard.grantRole(guard.GUARDIAN_ROLE(), guardian);
        vm.stopPrank();
        handler.setRoles(admin, guardian);
        // The handler signs vol posts and pokes PriceGuard; it needs nothing else.
        for (uint256 i; i < traders.length; ++i) {
            if (traders[i] != alice) {
                usdg.mint(traders[i], 1_000_000_000e6);
                vm.prank(traders[i]);
                usdg.approve(address(engine), type(uint256).max);
            }
        }
        holders.push(address(pool));
        holders.push(address(reserve));
        holders.push(address(fees));
        holders.push(treasury);
        holders.push(address(router));
        holders.push(address(engine));
        holders.push(address(adapter));
        holders.push(hedger);
        for (uint256 i; i < traders.length; ++i) {
            holders.push(traders[i]);
        }
        for (uint256 i; i < lps.length; ++i) {
            holders.push(lps[i]);
        }
        for (uint256 i; i < traders.length; ++i) {
            startBalance[traders[i]] = usdg.balanceOf(traders[i]);
        }
        targetContract(address(handler));
        bytes4[] memory sel = new bytes4[](15);
        sel[0] = SystemHandler.buy.selector;
        sel[1] = SystemHandler.sell.selector;
        sel[2] = SystemHandler.deposit.selector;
        sel[3] = SystemHandler.requestWithdraw.selector;
        sel[4] = SystemHandler.claim.selector;
        sel[5] = SystemHandler.hedge.selector;
        sel[6] = SystemHandler.keeperAccrueAll.selector;
        sel[7] = SystemHandler.move.selector;
        sel[8] = SystemHandler.gap.selector;
        sel[9] = SystemHandler.session.selector;
        sel[10] = SystemHandler.warp.selector;
        sel[11] = SystemHandler.buy.selector; // buys twice as likely
        sel[12] = SystemHandler.pause.selector;
        sel[13] = SystemHandler.volPost.selector;
        sel[14] = SystemHandler.hedgePost.selector;
        targetSelector(FuzzSelector({addr: address(handler), selectors: sel}));
    }

    mapping(address => uint256) internal startBalance;

    /// USDG conservation: every unit minted sits with a known holder; the engine and the adapter hold none.
    function invariant_usdgConserved() public view {
        uint256 sum;
        for (uint256 i; i < holders.length; ++i) {
            sum += usdg.balanceOf(holders[i]);
        }
        assertEq(sum, usdg.totalSupply(), "USDG conserved");
        assertEq(usdg.balanceOf(address(engine)), 0, "engine holds no USDG");
        assertEq(usdg.balanceOf(address(adapter)), 0, "adapter holds no USDG");
    }

    /// Pool solvency within caps: NAV stays positive through moves and 25% gaps, and a gap never loses more than the
    /// stress loss the engine measured on the book (the 20% stress budget gates every buy).
    function invariant_poolSolventWithinCaps() public view {
        assertGt(pool.nav(), 0, "NAV > 0");
        assertEq(handler.gapBreaches(), 0, "gap loss within the measured stress loss");
        assertEq(handler.stressBreaches(), 0, "no buy leaves the book over the stress budget");
    }

    /// A buyer's loss is bounded by the premium: USDG only leaves a trader as a buy's returned cost.
    function invariant_buyerLossBoundedByPremium() public view {
        for (uint256 i; i < traders.length; ++i) {
            address t = traders[i];
            assertEq(usdg.balanceOf(t), startBalance[t] - handler.paid(t) + handler.received(t), "trader USDG");
        }
        assertEq(handler.costMismatch(), 0, "transfers equal the returned cost and proceeds");
    }

    function invariant_normMonotone() public view {
        assertEq(handler.normRose(), 0);
    }

    /// bookValue == totalLiability right after the keeper's accrueMany of every live series.
    function invariant_totalLiabilityRecompute() public view {
        assertEq(handler.bookDrift(), 0);
    }

    /// Pool shares: supply == LP balances + the queue escrow held by the pool.
    function invariant_sharesSupplyMatchesHolders() public view {
        uint256 sum = pool.balanceOf(address(pool));
        for (uint256 i; i < lps.length; ++i) {
            sum += pool.balanceOf(lps[i]);
        }
        assertEq(sum, pool.totalSupply(), "shares supply == holders");
        assertEq(pool.balanceOf(address(pool)), pool.queuedShares(), "escrow == queued shares");
    }

    function invariant_noPanics() public view {
        assertEq(handler.panics(), 0);
    }

    /// Todo 10 R4: a sell on a fresh price never reverts, through guardian pauses, vol moves and hedge posts
    /// (a payout the pool cannot make is queued, not refused).
    function invariant_sellsWorkWhenPriceFresh() public view {
        assertEq(handler.sellFailures(), 0, "fresh-price sell reverted");
    }

    /// Deterministic R4 case: fill one name's book up to whatever cap binds first, then gap it 25% both ways (others
    /// 10% the same way): the loss stays within the stress loss the engine measured and within the 20% budget.
    function test_R4_fullBookGapWithinStressBudget() public {
        bytes32[] memory ids = new bytes32[](4);
        for (uint256 i; i < 4; ++i) {
            ids[i] = registry.idOf(address(stocks[0]), i % 2 == 0, uint128(i < 2 ? px[0] : (i == 2 ? px[0] * 90 / 100 : px[0] * 110 / 100)), i < 2 ? DAILY : WEEKLY);
        }
        address[] memory buyers = new address[](40);
        for (uint256 b; b < buyers.length; ++b) {
            buyers[b] = makeAddr(string.concat("buyer", vm.toString(b)));
            usdg.mint(buyers[b], 1_000_000e6);
            vm.prank(buyers[b]);
            usdg.approve(address(engine), type(uint256).max);
        }
        uint256 bought;
        for (uint256 b; b < buyers.length; ++b) {
            for (uint256 i; i < 4; ++i) {
                vm.prank(buyers[b]);
                try engine.buy(ids[i], 2_000e18, type(uint128).max, uint64(block.timestamp), buyers[b]) {
                    ++bought;
                } catch {}
            }
        }
        assertGt(bought, 10);
        for (uint256 dir; dir < 2; ++dir) {
            uint256 snap = vm.snapshotState();
            skip(1);
            _accrueAll();
            (uint256 stressLoss, int256 nav) = engine.stressLoss();
            assertLe(stressLoss * 10_000, uint256(nav) * 2_000 + uint256(nav) / 1_000, "book within the budget");
            int256 before = pool.nav();
            skip(1);
            for (uint256 i; i < stocks.length; ++i) {
                uint256 m = i == 0 ? 2_500 : 1_000;
                _setPrice(i, dir == 0 ? px[i] * (10_000 - m) / 10_000 : px[i] * (10_000 + m) / 10_000);
            }
            _accrueAll();
            int256 afterNav = pool.nav();
            uint256 loss = afterNav < before ? uint256(before - afterNav) : 0;
            emit log_named_uint(dir == 0 ? "down gap loss, bps of NAV" : "up gap loss, bps of NAV", loss * 10_000 / uint256(before));
            emit log_named_uint("measured stress loss, bps of NAV", stressLoss * 10_000 / uint256(nav));
            assertLe(loss, stressLoss * 102 / 100 + 1e18, "loss within measured stress");
            assertGt(afterNav, 0);
            vm.revertToState(snap);
        }
    }

    function afterInvariant() public {
        emit log_named_uint("buys", handler.buys());
        emit log_named_uint("sells", handler.sells());
        emit log_named_uint("claims", handler.claims());
        emit log_named_uint("gaps", handler.gaps());
        emit log_named_uint("worst gap loss, bps of NAV", handler.worstGapLossBps());
        emit log_named_uint("fresh sells", handler.freshSells());
        emit log_named_uint("pauses", handler.pauses());
        emit log_named_uint("vol posts (sigma moves)", handler.volPosts());
        emit log_named_uint("hedge posts", handler.hedgePosts());

    }
}
