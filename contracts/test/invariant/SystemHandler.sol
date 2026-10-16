// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {StdCheats} from "forge-std/StdCheats.sol";
import {StdUtils} from "forge-std/StdUtils.sol";
import {WriterPool} from "../../src/WriterPool.sol";
import {IWriterPool} from "../../src/interfaces/IWriterPool.sol";
import {MarketState} from "../../src/libs/LemniscateTypes.sol";
import {LemniscateEngine} from "../../src/LemniscateEngine.sol";
import {OptionToken} from "../../src/OptionToken.sol";
import {CpmmRouter} from "../mocks/CpmmRouter.sol";
import {MockFeed} from "../mocks/MockFeed.sol";
import {MockMarketHours} from "../mocks/MockMarketHours.sol";
import {MockStockToken} from "../mocks/MockStockToken.sol";
import {MockUSDG} from "../mocks/MockUSDG.sol";

/// @dev Drives the real engine + vault through trades, LP flows, keeper actions, oracle/regime changes, time, and pool
/// moves. Legitimate reverts are re-thrown so Foundry's per-selector revert table is meaningful; a Panic (overflow,
/// division by zero, bad enum) is never legitimate, so it is recorded in a ghost instead of being rolled back.
contract SystemHandler is CommonBase, StdCheats, StdUtils {
    uint256 internal constant USDG = 1e6;
    uint256 internal constant N = 2;
    uint256 internal constant ACTORS = 3;
    address internal constant KEEPER = address(0xCAFE);
    address internal constant TREASURY = address(0x5151);

    LemniscateEngine public immutable engine;
    WriterPool public immutable vault;
    MockUSDG public immutable usdg;
    MockMarketHours public immutable hours_;

    MockFeed[N] public feeds;
    MockStockToken[N] public stocks;
    OptionToken[N] public tokens;
    CpmmRouter[N] public routers;

    address[ACTORS] public traders;
    address[ACTORS] public lps;

    // ---------------------------------------------------------------- ghosts
    uint256 public ghostMinted;
    uint256 public ghostPanics;
    bytes public ghostLastPanic;
    uint256 public ghostRoundTripProfits;
    uint256 public ghostRoundTrips;
    uint256 public ghostMaxRoundTripGain;
    uint256 public ghostSharePriceDrops;
    uint256 public ghostMaxSharePriceDrop;
    uint256 public ghostSharePriceChecks;
    uint256 public ghostLockedMoves;
    uint256 public ghostLockedRejections;
    uint256 public ghostWithdrawCashShortReverts;
    bytes4 internal constant ERC20_INSUFFICIENT_BALANCE = 0xe450d38c;
    uint256 public ghostNormFactorIncreases;
    uint256 public ghostTreasuryDecreases;
    uint256[N] public ghostLastNormFactor;
    /// Set INVARIANT_REVERT_STATS=true to swallow (and count by selector) legitimate reverts instead of re-throwing.
    bool public immutable recordReverts;
    mapping(bytes4 => uint256) public revertCounts;
    bytes4[] public revertSelectors;
    uint256 public ghostLastTreasury;


    constructor(
        LemniscateEngine engine_,
        WriterPool vault_,
        MockUSDG usdg_,
        MockMarketHours hours__,
        MockFeed[N] memory feeds_,
        MockStockToken[N] memory stocks_,
        OptionToken[N] memory tokens_,
        CpmmRouter[N] memory routers_,
        uint256 initialMinted
    ) {
        engine = engine_;
        vault = vault_;
        usdg = usdg_;
        hours_ = hours__;
        feeds = feeds_;
        stocks = stocks_;
        tokens = tokens_;
        routers = routers_;
        ghostMinted = initialMinted;
        recordReverts = vm.envOr("INVARIANT_REVERT_STATS", false);
        for (uint256 i; i < ACTORS; ++i) {
            traders[i] = address(uint160(0x7000 + i));
            lps[i] = address(uint160(0x8000 + i));
        }
        for (uint256 i; i < N; ++i) {
            ghostLastNormFactor[i] = engine.getState(uint8(i)).normFactor;
        }
    }

    function trader(uint256 i) external view returns (address) {
        return traders[i];
    }

    function lp(uint256 i) external view returns (address) {
        return lps[i];
    }


    // ---------------------------------------------------------------- trading

    function buy(uint256 actorSeed, uint256 marketSeed, uint256 amount) external {
        address a = traders[actorSeed % ACTORS];
        uint8 id = uint8(marketSeed % N);
        amount = bound(amount, USDG, 400_000 * USDG);
        _fund(a, amount);
        vm.prank(a);
        try engine.buy(id, amount, 0, a, type(uint256).max) {
        } catch (bytes memory err) {
            _fail(err);
        }
        _after();
    }

    function sell(uint256 actorSeed, uint256 marketSeed, uint256 fractionBps) external {
        uint8 id = uint8(marketSeed % N);
        // Prefer an actor that holds tokens in some market so most calls exercise a real sell.
        address a = traders[actorSeed % ACTORS];
        for (uint256 k; k < ACTORS * N && tokens[id].balanceOf(a) == 0; ++k) {
            a = traders[(actorSeed % ACTORS + k) % ACTORS];
            if (k % ACTORS == ACTORS - 1) id = uint8((id + 1) % N);
        }
        uint256 balance = tokens[id].balanceOf(a);
        uint256 amount = balance * bound(fractionBps, 1, 10_000) / 10_000;
        if (amount == 0) amount = 1; // still exercised: reverts if balance is zero
        vm.prank(a);
        try engine.sell(id, amount, 0, a, type(uint256).max) {}
        catch (bytes memory err) {
            _fail(err);
        }
        _after();
    }

    /// Buy then immediately sell what was bought, same block and mark: the actor must not end with more USDG.
    function roundTrip(uint256 actorSeed, uint256 marketSeed, uint256 amount) external {
        address a = traders[actorSeed % ACTORS];
        uint8 id = uint8(marketSeed % N);
        amount = bound(amount, USDG, 400_000 * USDG);
        _fund(a, amount);
        uint256 before = usdg.balanceOf(a);
        vm.prank(a);
        try engine.buy(id, amount, 0, a, type(uint256).max) returns (uint256 tokensOut) {
            vm.prank(a);
            try engine.sell(id, tokensOut, 0, a, type(uint256).max) {
                ++ghostRoundTrips;
                uint256 afterBalance = usdg.balanceOf(a);
                if (afterBalance > before) {
                    ++ghostRoundTripProfits;
                    if (afterBalance - before > ghostMaxRoundTripGain) ghostMaxRoundTripGain = afterBalance - before;
                }
            } catch (bytes memory err) {
                _fail(err);
            }
        } catch (bytes memory err) {
            _fail(err);
        }
        _after();
    }

    // ---------------------------------------------------------------- LPs

    function deposit(uint256 lpSeed, uint256 amount) external {
        address a = lps[lpSeed % ACTORS];
        amount = bound(amount, USDG, 3_000_000 * USDG);
        _fund(a, amount);
        uint256 priceBefore = _sharePrice();
        vm.prank(a);
        try vault.deposit(amount, a) {
            _checkSharePrice(priceBefore);
        } catch (bytes memory err) {
            _fail(err);
        }
        _after();
    }

    function withdraw(uint256 lpSeed, uint256 amount) external {
        address a = _exitingLp(lpSeed);
        uint256 maxAssets = vault.maxWithdraw(a);
        amount = bound(amount, 1, maxAssets == 0 ? 1_000 * USDG : maxAssets);
        bool locked = vault.unlockTime(a) > vm.getBlockTimestamp();
        uint256 priceBefore = _sharePrice();
        vm.prank(a);
        try vault.withdraw(amount, a, a) {
            if (locked) ++ghostLockedMoves;
            _checkSharePrice(priceBefore);
        } catch (bytes memory err) {
            // A withdraw within maxWithdraw must raise the full amount in cash; a short final transfer is a bug, which
            // invariant_noPanicsAndTreasuryMonotone requires never to happen.
            if (err.length >= 4 && bytes4(err) == ERC20_INSUFFICIENT_BALANCE && amount <= maxAssets) {
                ++ghostWithdrawCashShortReverts;
                _after();
                return;
            }
            _failOrLocked(err);
        }
        _after();
    }

    function redeem(uint256 lpSeed, uint256 shares) external {
        address a = _exitingLp(lpSeed);
        uint256 maxShares = vault.maxRedeem(a);
        uint256 balance = vault.balanceOf(a);
        shares = bound(shares, 1, maxShares == 0 ? (balance == 0 ? 1 : balance) : maxShares);
        bool locked = vault.unlockTime(a) > vm.getBlockTimestamp();
        uint256 priceBefore = _sharePrice();
        vm.prank(a);
        try vault.redeem(shares, a, a) {
            if (locked) ++ghostLockedMoves;
            _checkSharePrice(priceBefore);
        } catch (bytes memory err) {
            _failOrLocked(err);
        }
        _after();
    }

    /// Three calls in four pick an LP that can exit now (if any); the rest probe locked or gated accounts.
    function _exitingLp(uint256 seed) internal view returns (address a) {
        a = lps[seed % ACTORS];
        if (seed % 4 == 0) return a;
        for (uint256 k; k < ACTORS; ++k) {
            address candidate = lps[(seed % ACTORS + k) % ACTORS];
            if (vault.maxRedeem(candidate) != 0) return candidate;
        }
    }

    function transferShares(uint256 fromSeed, uint256 toSeed, uint256 amount) external {
        address from = lps[fromSeed % ACTORS];
        address to = lps[toSeed % ACTORS];
        uint256 balance = vault.balanceOf(from);
        amount = bound(amount, 0, balance);
        bool locked = vault.unlockTime(from) > vm.getBlockTimestamp();
        vm.prank(from);
        try vault.transfer(to, amount) {
            if (locked) ++ghostLockedMoves;
        } catch (bytes memory err) {
            _failOrLocked(err);
        }
        _after();
    }

    // ---------------------------------------------------------------- keeper

    function rebalance(uint256 marketSeed) external {
        uint8 id = uint8(marketSeed % N);
        vm.prank(KEEPER);
        try vault.rebalance(id) {
        } catch (bytes memory err) {
            _fail(err);
        }
        _after();
    }

    function setBaseCarry(uint256 marketSeed, int256 stepBps) external {
        uint8 id = uint8(marketSeed % N);
        MarketState memory st = engine.getState(id);
        // Mostly skip calls the once-per-day rule would reject; keep a quarter to exercise the guard.
        if (vm.getBlockTimestamp() < st.baseCarryUpdatedAt + 1 days && marketSeed % 4 != 0) return;
        int256 current = st.baseCarryWad;
        int256 next = current + current * bound(stepBps, -2_500, 2_500) / 10_000;
        // Stay inside the configured [3e15, 5e15] band, so reverts come from the cadence/step guards under test.
        if (next < 3e15) next = 3e15;
        if (next > 5e15) next = 5e15;
        vm.prank(KEEPER);
        try engine.setBaseCarry(id, int64(next)) {}
        catch (bytes memory err) {
            _fail(err);
        }
        _after();
    }

    function accrueAll() external {
        try engine.accrueAll() {
        } catch (bytes memory err) {
            _fail(err);
        }
        _after();
    }

    // ---------------------------------------------------------------- environment

    /// Feed moves of at most ±10% per step within [$5, $5,000]; optionally the pool is arbitraged to follow.
    function movePrice(uint256 marketSeed, int256 moveBps, bool arb) external {
        uint256 id = marketSeed % N;
        (, int256 answer,,,) = feeds[id].latestRoundData();
        int256 next = answer * (10_000 + bound(moveBps, -1_000, 1_000)) / 10_000;
        if (next < 5e8) next = 5e8;
        if (next > 5_000e8) next = 5_000e8;
        feeds[id].setAnswer(next);
        if (arb) _arb(id, 0);
        _after();
    }

    /// Pool-only repricing within ±3% of the feed (arbitrage lag, 24/7 venue drift).
    function repricePool(uint256 marketSeed, int256 deviationBps) external {
        _arb(marketSeed % N, bound(deviationBps, -300, 300));
        _after();
    }

    function setOpen(bool open) external {
        hours_.setOpen(open);
        _after();
    }

    /// Pauses a stock's oracle one time in six and otherwise clears it, so paused spells are short.
    function toggleOraclePaused(uint256 marketSeed) external {
        uint256 id = marketSeed % N;
        stocks[id].setOraclePaused(marketSeed % 6 == 0);
        _after();
    }

    /// Time passes (up to 12 hours, or up to 2 days one time in eight). Feeds post a heartbeat round at the same
    /// answer five times in six; otherwise they go quiet, which lets the staleness guards trip.
    function warp(uint256 seconds_) external {
        uint256 maxStep = seconds_ % 8 == 0 ? 2 days : 12 hours;
        vm.warp(vm.getBlockTimestamp() + bound(seconds_, 1 minutes, maxStep));
        if (seconds_ % 6 != 1) {
            for (uint256 i; i < N; ++i) {
                (, int256 answer,,,) = feeds[i].latestRoundData();
                feeds[i].setAnswer(answer);
            }
        }
        _after();
    }

    // ---------------------------------------------------------------- helpers

    function revertSelectorCount() external view returns (uint256) {
        return revertSelectors.length;
    }

    function sharePrice() external view returns (uint256) {
        return _sharePrice();
    }

    function _sharePrice() internal view returns (uint256) {
        if (vault.totalSupply() == 0) return 0;
        return vault.navPerShareWad();
    }

    /// An LP operation at an unchanged mark must not lower NAV per share. Tolerance: 1 wei plus 1e-12 relative, the
    /// size of ERC-4626 virtual-share rounding (10**6 virtual shares against >= 1e12 real ones).
    function _checkSharePrice(uint256 before) internal {
        if (before == 0 || vault.totalSupply() == 0) return;
        ++ghostSharePriceChecks;
        uint256 afterPrice = vault.navPerShareWad();
        if (afterPrice >= before) return;
        uint256 drop = before - afterPrice;
        if (drop > ghostMaxSharePriceDrop) ghostMaxSharePriceDrop = drop;
        if (drop > 1 + before / 1e12) ++ghostSharePriceDrops;
    }

    function _arb(uint256 id, int256 deviationBps) internal {
        (, int256 answer,,,) = feeds[id].latestRoundData();
        uint256 priceWad = uint256(answer) * 1e10 * uint256(10_000 + deviationBps) / 10_000;
        uint256 depth = 500_000_000 * USDG;
        routers[id].setReserves(depth, depth * 1e30 / priceWad);
    }

    function _fund(address a, uint256 amount) internal {
        uint256 balance = usdg.balanceOf(a);
        if (balance >= amount) return;
        uint256 topUp = amount - balance;
        usdg.mint(a, topUp);
        ghostMinted += topUp;
        vm.startPrank(a);
        usdg.approve(address(engine), type(uint256).max);
        usdg.approve(address(vault), type(uint256).max);
        vm.stopPrank();
    }



    /// The lock guard is expected; count it (state kept) so runs show locked exits are actually attempted.
    function _failOrLocked(bytes memory err) internal {
        if (err.length == 4 && bytes4(err) == IWriterPool.WithdrawalLocked.selector) {
            ++ghostLockedRejections;
            return;
        }
        _fail(err);
    }

    /// Panics are bugs: keep the call's state and flag it. Anything else is a legitimate guard: re-throw.
    function _fail(bytes memory err) internal {
        if (err.length >= 4 && bytes4(err) == bytes4(0x4e487b71)) {
            ++ghostPanics;
            ghostLastPanic = err;
            return;
        }
        if (recordReverts) {
            bytes4 selector = bytes4(err);
            if (revertCounts[selector]++ == 0) revertSelectors.push(selector);
            return;
        }
        assembly {
            revert(add(err, 0x20), mload(err))
        }
    }

    /// Post-call ghosts: stored normFactor never rises (carry is non-negative); the treasury never loses USDG.
    function _after() internal {
        for (uint256 i; i < N; ++i) {
            uint256 nf = engine.getState(uint8(i)).normFactor;
            if (nf > ghostLastNormFactor[i]) ++ghostNormFactorIncreases;
            ghostLastNormFactor[i] = nf;
        }
        uint256 t = usdg.balanceOf(TREASURY);
        if (t < ghostLastTreasury) ++ghostTreasuryDecreases;
        ghostLastTreasury = t;
    }
}
