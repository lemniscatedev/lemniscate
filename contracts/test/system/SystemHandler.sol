// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LemniscateEngine} from "../../src/LemniscateEngine.sol";
import {WriterPool} from "../../src/WriterPool.sol";
import {SeriesRegistry} from "../../src/SeriesRegistry.sol";
import {VolOracle} from "../../src/VolOracle.sol";
import {PriceGuard} from "../../src/PriceGuard.sol";
import {IVolOracle} from "../../src/interfaces/IVolOracle.sol";
import {PriceReading, SessionKind, Speed} from "../../src/libs/OptionTypes.sol";
import {MockGuardFeed, MockKindHours} from "../mocks/PriceGuardMocks.sol";
import {MockSwapRouter} from "../mocks/MockSwapRouter.sol";

interface IMintable {
    function mint(address to, uint256 amount) external;
}

/// @notice Drives the REAL engine + pool (SystemFixture) with traders, LPs, the keeper, the hedger, price moves,
/// 25% gaps and time. Expected reverts are swallowed; Panics and broken system properties are counted in ghosts that
/// the invariant test asserts are zero.
contract SystemHandler is Test {
    uint256 internal constant WAD = 1e18;
    uint24 internal constant FEE = 500;
    uint256 internal constant SIGNER_PK = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80; // test-key

    LemniscateEngine public engine;
    WriterPool public pool;
    SeriesRegistry public registry;
    VolOracle public vol;
    PriceGuard public guard;
    MockKindHours public hours_;
    MockSwapRouter public router;
    IERC20 public usdg;
    address public hedger;

    address[] public stocks;
    MockGuardFeed[] public feeds;
    uint256[] public px;
    uint256[] public px0;
    bytes32[] public ids;
    address[] public traders;
    address[] public lps;
    uint256[] public tickets;

    uint64 internal nonce;
    uint256 internal lastVolPost;

    // ghosts
    mapping(address => uint256) public paid; // USDG each trader paid for buys
    mapping(address => uint256) public received; // USDG each trader received from sells
    mapping(bytes32 => uint256) public lastNorm;
    uint256 public panics;
    uint256 public normRose;
    uint256 public costMismatch; // a buy took more USDG than its returned cost, or a sell paid other than returned
    uint256 public bookDrift; // bookValue != totalLiability right after accrueMany of every live series
    uint256 public gapBreaches; // a gap lost more than the stress loss the engine had measured
    uint256 public stressBreaches; // a buy left the book over the stress budget
    uint256 public gaps;
    uint256 public breachLoss;
    uint256 public breachStress;
    uint256 public breachNav;
    uint8 public breachSession;
    bool public breachUp;
    uint256 public worstGapLossBps; // loss / NAV of the worst gap seen
    uint256 public buys;
    uint256 public sells;
    uint256 public claims;
    // todo 10 R4 additions: guardian pauses, vol posts that move sigma, hedge equity posts, fresh-price sells
    address public admin;
    address public guardian;
    uint64 public sigma = 5000;
    uint256 public equity;
    bool public equityPosted;
    uint256 public pauses;
    uint256 public unpauses;
    uint256 public volPosts;
    uint256 public hedgePosts;
    uint256 public freshSells; // sells attempted while the price was fresh
    uint256 public sellFailures; // ... that reverted
    bytes public lastSellFailure;

    constructor(
        LemniscateEngine engine_,
        WriterPool pool_,
        SeriesRegistry registry_,
        VolOracle vol_,
        PriceGuard guard_,
        MockKindHours hours__,
        MockSwapRouter router_,
        IERC20 usdg_,
        address hedger_
    ) {
        engine = engine_;
        pool = pool_;
        registry = registry_;
        vol = vol_;
        guard = guard_;
        hours_ = hours__;
        router = router_;
        usdg = usdg_;
        hedger = hedger_;
    }

    function init(
        address[] calldata stocks_,
        MockGuardFeed[] calldata feeds_,
        uint256[] calldata px_,
        bytes32[] calldata ids_,
        address[] calldata traders_,
        address[] calldata lps_,
        uint64 nonce_
    ) external {
        require(stocks.length == 0, "once"); // the fuzzer calls every handler function; set up only once
        stocks = stocks_;
        for (uint256 i; i < feeds_.length; ++i) {
            feeds.push(feeds_[i]);
        }
        px = px_;
        px0 = px_;
        ids = ids_;
        traders = traders_;
        lps = lps_;
        for (uint256 i; i < ids_.length; ++i) {
            lastNorm[ids_[i]] = registry.seriesOf(ids_[i]).norm;
        }
        lastVolPost = block.timestamp;
        nonce = nonce_;
    }

    function setRoles(address admin_, address guardian_) external {
        require(admin == address(0), "once");
        admin = admin_;
        guardian = guardian_;
    }

    // --------------------------------------------------------------------------------------------- traders

    function buy(uint256 a, uint256 s, uint256 units) external {
        address who = traders[a % traders.length];
        bytes32 id = ids[s % ids.length];
        units = bound(units, 1e17, 50e18);
        uint256 before = usdg.balanceOf(who);
        vm.prank(who);
        try engine.buy(id, uint128(units), type(uint128).max, uint64(block.timestamp), who) returns (uint256 cost, uint256) {
            ++buys;
            paid[who] += cost;
            if (before - usdg.balanceOf(who) != cost) ++costMismatch;
            (uint256 loss, int256 nav) = engine.stressLoss();
            // the buy itself checked the post-trade book against the budget (20% of NAV)
            if (nav > 0 && loss * 10_000 > uint256(nav) * 2_000 + uint256(nav) / 1_000) ++stressBreaches;
        } catch (bytes memory err) {
            _checkPanic(err);
        }
        _afterAction();
    }

    function sell(uint256 a, uint256 s, uint256 frac) external {
        address who = traders[a % traders.length];
        bytes32 id = ids[s % ids.length];
        uint256 bal = IERC20(registry.seriesOf(id).token).balanceOf(who);
        if (bal == 0) return;
        uint256 tokens = bal * bound(frac, 1, 100) / 100;
        if (tokens == 0) return;
        // Review F08/F14: a partial sell must move and leave at least the minimum trade; the whole balance always sells.
        if (tokens < bal && !_partialSellAllowed(id, who, tokens, bal)) tokens = bal;
        uint256 before = usdg.balanceOf(who);
        PriceReading memory r = guard.readLite(registry.seriesOf(id).stock);
        bool fresh = r.fresh && r.session != SessionKind.HALTED;
        if (fresh) ++freshSells;
        vm.prank(who);
        try engine.sell(id, uint128(tokens), 0, uint64(block.timestamp), who) returns (uint256 proceeds) {
            ++sells;
            received[who] += proceeds;
            if (usdg.balanceOf(who) - before != proceeds) ++costMismatch;
        } catch (bytes memory err) {
            _checkPanic(err);
            // Sells are never refused on a fresh price, whatever is paused (decision 3, R4 sellsWorkWhenPriceFresh).
            if (fresh) {
                ++sellFailures;
                lastSellFailure = err;
            }
        }
        _afterAction();
    }

    function _partialSellAllowed(bytes32 id, address who, uint256 tokens, uint256 bal) internal view returns (bool) {
        who;
        (uint256 v,,,) = engine.vMark(id);
        uint256 norm = registry.seriesOf(id).norm;
        uint256 minWad = 1e18; // the default $1 minimum trade
        // a margin for the accrual the sell runs first (norm only falls)
        uint256 sold = Math.mulDiv(Math.mulDiv(tokens, norm, 1e18), v, 1e18);
        uint256 left = Math.mulDiv(Math.mulDiv(bal - tokens, norm, 1e18), v, 1e18);
        return sold >= 2 * minWad && left >= 2 * minWad;
    }

    // -------------------------------------------------------------------------------------------------- LPs

    function deposit(uint256 a, uint256 amount) external {
        address who = lps[a % lps.length];
        amount = bound(amount, 1_000e6, 500_000e6);
        IMintable(address(usdg)).mint(who, amount);
        vm.startPrank(who);
        usdg.approve(address(pool), amount);
        try pool.deposit(amount, who) {} catch (bytes memory err) {
            _checkPanic(err);
        }
        vm.stopPrank();
        _afterAction();
    }

    function requestWithdraw(uint256 a, uint256 frac) external {
        address who = lps[a % lps.length];
        uint256 shares = pool.balanceOf(who) * bound(frac, 1, 50) / 100;
        if (shares == 0) return;
        vm.prank(who);
        try pool.requestWithdraw(shares) returns (uint256 t) {
            tickets.push(t);
        } catch (bytes memory err) {
            _checkPanic(err);
        }
        _afterAction();
    }

    function claim(uint256 t) external {
        if (tickets.length == 0) return;
        try pool.claim(tickets[t % tickets.length]) {
            ++claims;
        } catch (bytes memory err) {
            _checkPanic(err);
        }
        _afterAction();
    }

    // -------------------------------------------------------------------------------------- hedger, keeper

    function hedge(uint256 n, uint256 units) external {
        address stock = stocks[n % stocks.length];
        // The hedger hedges the holders' delta of names with live options and unwinds the rest: the engine's stress
        // test counts the pool's spot only on names it has a book for (see the 07b notes).
        (int256 delta,,) = engine.netGreeks(stock);
        uint256 cap = delta > 0 && engine.liveSeries(stock).length != 0 ? uint256(delta) : 0;
        units = bound(units, 0, cap);
        vm.prank(hedger);
        try pool.rebalance(stock, units, 0) {} catch (bytes memory err) {
            _checkPanic(err);
        }
        _afterAction();
    }

    /// The keeper accrues every live series; right after it, the O(1) book value equals the full recomputation.
    function keeperAccrueAll() external {
        skip(1); // a new block: series touched earlier in this block at another price are re-marked too
        _accrueAll();
        uint256 book = engine.bookValue();
        uint256 exact = engine.totalLiability();
        uint256 diff = book > exact ? book - exact : exact - book;
        if (diff > 1_000 + exact / 1e12) ++bookDrift;
        _afterAction();
    }

    // ------------------------------------------------------------------------------------------ market

    /// An ordinary move of up to 3% on one name.
    function move(uint256 n, uint256 bps, bool up) external {
        uint256 i = n % stocks.length;
        bps = bound(bps, 1, 300);
        _setPrice(i, _moved(i, bps, up));
        _afterAction();
    }

    /// A 25% gap on one name and up to 10% on every other, after the keeper has re-marked the whole book. The pool
    /// must lose no more than the stress loss the engine measured on that book (spec 4.2), and stay solvent.
    function gap(uint256 n, bool up, uint256 others) external {
        skip(1);
        _accrueAll();
        (uint256 stressLoss, int256 navBefore) = engine.stressLoss();
        int256 before = pool.nav();
        skip(1); // a new block: the post-gap accrual re-marks every series
        uint256 i = n % stocks.length;
        _setPrice(i, _moved(i, 2_500, up));
        for (uint256 j; j < stocks.length; ++j) {
            if (j == i) continue;
            uint256 b = bound(uint256(keccak256(abi.encode(others, j))), 0, 1_000);
            _setPrice(j, _moved(j, b, (others >> j) & 1 == 1));
        }
        _accrueAll();
        int256 afterNav = pool.nav();
        ++gaps;
        if (before > 0 && navBefore > 0) {
            uint256 loss = afterNav < before ? uint256(before - afterNav) : 0;
            uint256 lossBps = loss * 10_000 / uint256(before);
            if (lossBps > worstGapLossBps) worstGapLossBps = lossBps;
            // 2% model tolerance (sigma is re-read at the new S) plus one USDG
            if (loss > stressLoss * 102 / 100 + 1e18) {
                ++gapBreaches;
                breachLoss = loss;
                breachStress = stressLoss;
                breachNav = uint256(before);
                breachSession = uint8(hours_.kind());
                breachUp = up;
            }
        }
        _afterAction();
    }

    function session(uint256 k) external {
        SessionKind kind = [SessionKind.REGULAR, SessionKind.REGULAR, SessionKind.EXTENDED, SessionKind.CLOSED][k % 4];
        hours_.setKind(kind);
        _afterAction();
    }

    /// Time passes (5 minutes to 2 hours); feeds print, vols are re-posted, the hedger re-posts its equity (hourly
    /// in production), the keeper accrues half the time.
    function warp(uint256 secs, bool accrue) external {
        skip(bound(secs, 5 minutes, 2 hours));
        for (uint256 i; i < stocks.length; ++i) {
            _setPrice(i, px[i]);
        }
        _postVols();
        if (equityPosted) _postEquity(equity, bytes32(0));
        if (accrue) _accrueAll();
        _afterAction();
    }

    // --------------------------------------------------------------------------------- guardian, admin, oracles

    /// The guardian pauses buys (engine, one series, one name in PriceGuard) or deposits; the admin lifts it.
    function pause(uint256 k, uint256 n, bool on) external {
        if (guardian == address(0)) return;
        uint256 what = k % 4;
        address stock = stocks[n % stocks.length];
        bytes32 id = ids[n % ids.length];
        vm.startPrank(on ? guardian : admin);
        if (what == 0) engine.setBuysPaused(on);
        else if (what == 1) engine.setSeriesBuysPaused(id, on);
        else if (what == 2) guard.setBuysPaused(stock, on);
        else pool.setDepositsPaused(on);
        vm.stopPrank();
        if (on) ++pauses;
        else ++unpauses;
        _afterAction();
    }

    /// The vol signer moves sigma by up to 20% (inside the oracle's 25% step); a post the rolling-hour bound refuses
    /// keeps the old sigma.
    function volPost(uint256 step, bool up) external {
        if (block.timestamp < lastVolPost + 5 minutes) skip(lastVolPost + 5 minutes - block.timestamp);
        uint256 delta = uint256(sigma) * bound(step, 0, 2_000) / 10_000;
        uint256 next = up ? sigma + delta : sigma - delta;
        if (next < 3_500) next = 3_500;
        if (next > 9_000) next = 9_000;
        uint64 prior = sigma;
        sigma = uint64(next);
        bool ok = true;
        for (uint256 i; i < stocks.length && ok; ++i) {
            ok = _tryPost(stocks[i], Speed.DAILY) && _tryPost(stocks[i], Speed.WEEKLY);
        }
        if (ok) {
            ++volPosts;
            lastVolPost = block.timestamp;
        } else {
            sigma = prior; // later posts re-send the old value
        }
        _afterAction();
    }

    /// The hedger posts perp-venue equity (decision 19; zero to small, as no perp account exists yet).
    function hedgePost(uint256 amount) external {
        if (block.timestamp == 0) return;
        _postEquity(bound(amount, 0, 10_000e6), keccak256(abi.encode(block.timestamp, amount)));
        _afterAction();
    }

    function _postEquity(uint256 amount, bytes32 ref) internal {
        vm.prank(hedger);
        try pool.postHedgeEquity(amount, uint64(block.timestamp), ref) {
            equity = amount;
            equityPosted = true;
            ++hedgePosts;
        } catch (bytes memory err) {
            _checkPanic(err);
        }
    }

    // ----------------------------------------------------------------------------------------- internals

    function _moved(uint256 i, uint256 bps, bool up) internal view returns (uint256) {
        // Stay within [0.4, 2.5] x the start price (strike band, pricing domain): bounce back at the edges.
        if (up && px[i] * (10_000 + bps) / 10_000 > px0[i] * 5 / 2) up = false;
        if (!up && px[i] * (10_000 - bps) / 10_000 < px0[i] * 2 / 5) up = true;
        return up ? px[i] * (10_000 + bps) / 10_000 : px[i] * (10_000 - bps) / 10_000;
    }

    function _setPrice(uint256 i, uint256 s) internal {
        px[i] = s;
        feeds[i].push(int256(s / 1e10));
        guard.poke(stocks[i]);
        router.setRate(address(usdg), stocks[i], FEE, 1e48 / s);
        router.setRate(stocks[i], address(usdg), FEE, s / 1e12);
    }

    function _postVols() internal {
        if (block.timestamp < lastVolPost + 5 minutes) return;
        for (uint256 i; i < stocks.length; ++i) {
            _post(stocks[i], Speed.DAILY);
            _post(stocks[i], Speed.WEEKLY);
        }
        lastVolPost = block.timestamp;
    }

    function _post(address stock, Speed speed) internal {
        IVolOracle.Post memory p = IVolOracle.Post({
            stock: stock,
            speed: speed,
            sigmaBps: sigma,
            skewK: 0,
            eventBumpBps: 0,
            buyBlockFrom: 0,
            buyBlockTo: 0,
            validUntil: uint64(block.timestamp + 2 hours),
            nonce: ++nonce
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, vol.hashPost(p));
        vol.post(p, abi.encodePacked(r, s, v));
    }

    function _tryPost(address stock, Speed speed) internal returns (bool) {
        IVolOracle.Post memory p = IVolOracle.Post({
            stock: stock,
            speed: speed,
            sigmaBps: sigma,
            skewK: 0,
            eventBumpBps: 0,
            buyBlockFrom: 0,
            buyBlockTo: 0,
            validUntil: uint64(block.timestamp + 2 hours),
            nonce: ++nonce
        });
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(SIGNER_PK, vol.hashPost(p));
        try vol.post(p, abi.encodePacked(r, s, v)) {
            return true;
        } catch (bytes memory err) {
            _checkPanic(err);
            return false;
        }
    }

    function _accrueAll() internal {
        uint256 n;
        for (uint256 i; i < stocks.length; ++i) {
            n += engine.liveSeries(stocks[i]).length;
        }
        bytes32[] memory all = new bytes32[](n);
        n = 0;
        for (uint256 i; i < stocks.length; ++i) {
            bytes32[] memory l = engine.liveSeries(stocks[i]);
            for (uint256 j; j < l.length; ++j) {
                all[n++] = l[j];
            }
        }
        try engine.accrueMany(all) {} catch (bytes memory err) {
            _checkPanic(err);
        }
        // accrueMany skips dust series (review F08/F24: they accrue lazily); the invariant re-marks them one by one.
        for (uint256 i; i < all.length; ++i) {
            try engine.accrue(all[i]) {} catch (bytes memory err) {
                _checkPanic(err);
            }
        }
    }

    function _afterAction() internal {
        for (uint256 i; i < ids.length; ++i) {
            uint256 n = registry.seriesOf(ids[i]).norm;
            if (n > lastNorm[ids[i]]) ++normRose;
            lastNorm[ids[i]] = n;
        }
    }

    function _checkPanic(bytes memory err) internal {
        if (err.length >= 4 && bytes4(err) == bytes4(0x4e487b71)) ++panics;
    }

    function traderCount() external view returns (uint256) {
        return traders.length;
    }

    function lpCount() external view returns (uint256) {
        return lps.length;
    }
}
