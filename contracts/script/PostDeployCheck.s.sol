// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {IWriterPool} from "../src/interfaces/IWriterPool.sol";
import {IMarketHours} from "../src/interfaces/IMarketHours.sol";
import {ILemniscateLens} from "../src/interfaces/ILemniscateLens.sol";
import {ILemniscateEngine} from "../src/interfaces/ILemniscateEngine.sol";
import {IPriceReference} from "../src/interfaces/IPriceReference.sol";
import {MarketConfig, MarketState, MarketView, Regime, VaultView} from "../src/libs/LemniscateTypes.sol";
import {LemniscateScript, IUniswapV3PoolOps, IUUPSOps} from "./lib/LemniscateScript.sol";

interface IFeedDescription {
    function description() external view returns (string memory);
}

interface ITwapWindow {
    function window() external view returns (uint32);
}

interface IVaultUsdg {
    function usdg() external view returns (address);
}

/// @title PostDeployCheck
/// @notice Read-only health check of a live LEMNISCATE deployment. Never broadcasts; run it with only an RPC URL:
///   forge script script/PostDeployCheck.s.sol --rpc-url $RPC_URL
/// Prints one PASS/WARN/FAIL line per check and reverts when any check fails (unless REPORT_ONLY=1).
/// @dev Missing functions (an implementation older than the checks) are caught and reported, not fatal. The phase
/// (`pre` = before the V2 upgrade, `post` = after) is detected from `WriterPool.priceReference()` and can be forced with
/// CHECK_PHASE. See script/README.md for every environment variable.
contract PostDeployCheck is LemniscateScript {
    uint256 private constant BPS = 10_000;

    uint256 private _pass;
    uint256 private _warn;
    uint256 private _fail;

    Deployment private _d;
    bool private _post;
    address[] private _admins;
    address[] private _keepers;
    address[] private _guardians;
    address[] private _candidates;
    address private _timelock;
    address private _safe;

    function run() external {
        Deployment memory d = loadDeployment();
        _copy(d);
        console2.log("== LEMNISCATE post-deploy check, chain", block.chainid, "timestamp", block.timestamp);
        logDeployment(d);

        _detectPhase();
        _loadExpectedRoles();

        _checkCode();
        _checkImplementations();
        _checkWiring();
        _checkRoles();
        _checkTimelock();
        _checkGlobal();
        _checkVault();
        _checkHours();
        _checkMarkets();
        _checkLens();

        console2.log("== summary: PASS", _pass);
        console2.log("            WARN", _warn);
        console2.log("            FAIL", _fail);
        if (_fail != 0 && !vm.envOr("REPORT_ONLY", false)) {
            revert(string.concat("PostDeployCheck: ", vm.toString(_fail), " check(s) failed"));
        }
    }

    // ---------------------------------------------------------------- setup

    function _copy(Deployment memory d) private {
        _d.chainId = d.chainId;
        _d.engine = d.engine;
        _d.vault = d.vault;
        _d.marketHours = d.marketHours;
        _d.lens = d.lens;
        _d.hedgeAdapter = d.hedgeAdapter;
        _d.usdg = d.usdg;
        _d.engineImpl = d.engineImpl;
        _d.vaultImpl = d.vaultImpl;
        _d.marketHoursImpl = d.marketHoursImpl;
        _d.admin = d.admin;
        _d.keeper = d.keeper;
        _d.deployBlock = d.deployBlock;
        _d.source = d.source;
        for (uint256 i; i < d.markets.length; ++i) {
            _d.markets.push(d.markets[i]);
        }
    }

    function _detectPhase() private {
        string memory phase = vm.envOr("CHECK_PHASE", string("auto"));
        if (_eq(phase, "pre")) {
            _post = false;
        } else if (_eq(phase, "post")) {
            _post = true;
        } else {
            (bool ok, bytes memory ret) = _d.vault.staticcall(abi.encodeCall(IWriterPool.priceReference, ()));
            _post = ok && ret.length == 32;
        }
        console2.log(_post ? "phase: post-upgrade (V2 checks enforced)" : "phase: pre-upgrade (V2 checks reported only)");
    }

    function _loadExpectedRoles() private {
        address[] memory none = new address[](0);
        _timelock = vm.envOr("TIMELOCK", address(0));
        _safe = vm.envOr("SAFE", address(0));

        address[] memory admins = vm.envOr("EXPECTED_ADMINS", ",", none);
        if (admins.length == 0) {
            if (_timelock != address(0)) {
                admins = new address[](1);
                admins[0] = _timelock;
                if (_d.admin != address(0) && vm.envOr("ALLOW_EOA_ADMIN", false)) {
                    admins = new address[](2);
                    admins[0] = _timelock;
                    admins[1] = _d.admin;
                }
            } else if (_d.admin != address(0)) {
                admins = new address[](1);
                admins[0] = _d.admin;
            }
        }
        _admins = admins;

        address[] memory keepers = vm.envOr("EXPECTED_KEEPERS", ",", none);
        if (keepers.length == 0 && _d.keeper != address(0)) {
            keepers = new address[](1);
            keepers[0] = _d.keeper;
        }
        _keepers = keepers;

        // Deploy grants GUARDIAN to the keeper and to the admin account; a fast EOA or Safe may keep it after the
        // timelock handoff because pausing buys never blocks sells.
        address[] memory guardians = vm.envOr("EXPECTED_GUARDIANS", ",", none);
        if (guardians.length == 0) {
            guardians = new address[](keepers.length + (_d.admin != address(0) ? 1 : 0));
            for (uint256 i; i < keepers.length; ++i) {
                guardians[i] = keepers[i];
            }
            if (_d.admin != address(0)) guardians[keepers.length] = _d.admin;
        }
        _guardians = guardians;

        _addCandidates(_admins);
        _addCandidates(_keepers);
        _addCandidates(_guardians);
        _addCandidate(_d.admin);
        _addCandidate(_d.keeper);
        _addCandidate(_timelock);
        _addCandidate(_safe);
        _addCandidate(vm.envOr("DEPLOYER", address(0)));
        _addCandidates(vm.envOr("ROLE_CANDIDATES", ",", none));
        _addCandidate(_d.engine);
        _addCandidate(_d.vault);
        _addCandidate(_d.marketHours);
    }

    // ---------------------------------------------------------------- checks

    function _checkCode() private {
        _section("code");
        _requireCode("engine", _d.engine);
        _requireCode("vault", _d.vault);
        _requireCode("marketHours", _d.marketHours);
        _requireCode("lens", _d.lens);
        _requireCode("hedgeAdapter", _d.hedgeAdapter);
        _requireCode("usdg", _d.usdg);
    }

    function _checkImplementations() private {
        _section("implementations");
        _checkImpl("engine", _d.engine, _d.engineImpl);
        _checkImpl("vault", _d.vault, _d.vaultImpl);
        _checkImpl("marketHours", _d.marketHours, _d.marketHoursImpl);

        address engineImpl = implementationOf(_d.engine);
        address vaultImpl = implementationOf(_d.vault);
        address hoursImpl = implementationOf(_d.marketHours);
        address any = address(0xdead);
        _expectInitRevert(
            "engine impl initialize() reverts",
            engineImpl,
            abi.encodeCall(
                ILemniscateEngine.initialize, (any, IERC20(any), IWriterPool(any), IMarketHours(any), any)
            )
        );
        _expectInitRevert(
            "vault impl initialize() reverts",
            vaultImpl,
            abi.encodeCall(IWriterPool.initialize, (any, IERC20(any), ILemniscateEngine(any)))
        );
        _expectInitRevert(
            "marketHours impl initialize() reverts", hoursImpl, abi.encodeCall(IMarketHours.initialize, (any, any))
        );
    }

    function _checkImpl(string memory name, address proxy, address expected) private {
        address impl = implementationOf(proxy);
        if (impl == address(0) || impl.code.length == 0) {
            _failed(string.concat(name, " implementation slot empty or no code"));
            return;
        }
        if (expected == address(0)) {
            _warned(string.concat(name, " implementation not pinned (set *_IMPL): ", vm.toString(impl)));
        } else if (impl == expected) {
            _passed(string.concat(name, " implementation ", vm.toString(impl)));
        } else {
            _failed(string.concat(name, " implementation ", vm.toString(impl), " != expected ", vm.toString(expected)));
        }
        try IUUPSOps(impl).proxiableUUID() returns (bytes32 uuid) {
            _check(uuid == IMPLEMENTATION_SLOT, string.concat(name, " implementation is UUPS (proxiableUUID)"));
        } catch {
            _failed(string.concat(name, " implementation has no proxiableUUID"));
        }
        _check(initializersDisabled(impl), string.concat(name, " implementation initializers disabled"));
    }

    /// @dev Local simulation only: the script never broadcasts, so a call here never reaches the chain.
    function _expectInitRevert(string memory label, address impl, bytes memory data) private {
        if (impl == address(0)) return;
        (bool ok,) = impl.call(data);
        _check(!ok, label);
    }

    function _checkWiring() private {
        _section("wiring");
        ILemniscateEngine engine = ILemniscateEngine(_d.engine);
        IWriterPool vault = IWriterPool(_d.vault);
        _check(address(engine.vault()) == _d.vault, "engine.vault() == vault");
        _check(address(vault.engine()) == _d.engine, "vault.engine() == engine");
        _check(address(engine.usdg()) == _d.usdg, "engine.usdg() == usdg");
        _check(IVaultUsdg(_d.vault).usdg() == _d.usdg, "vault.usdg() == usdg");
        _check(vault.asset() == _d.usdg, "vault.asset() == usdg");
        _check(address(engine.marketHours()) == _d.marketHours, "engine.marketHours() == marketHours");
        address treasury = engine.treasury();
        address expectedTreasury = vm.envOr("TREASURY", address(0));
        if (expectedTreasury != address(0)) {
            _check(treasury == expectedTreasury, string.concat("treasury == TREASURY ", vm.toString(treasury)));
        } else {
            _check(treasury != address(0), string.concat("treasury set ", vm.toString(treasury)));
        }
    }

    function _checkRoles() private {
        _section("roles");
        if (_admins.length == 0) {
            _warned("no expected admin (set ADMIN, TIMELOCK or EXPECTED_ADMINS): admin roles not verified");
        }
        if (_keepers.length == 0) _warned("no expected keeper (set KEEPER or EXPECTED_KEEPERS): keeper roles not verified");

        address[3] memory targets = [_d.engine, _d.vault, _d.marketHours];
        string[3] memory names = ["engine", "vault", "marketHours"];
        for (uint256 t; t < 3; ++t) {
            for (uint256 i; i < _admins.length; ++i) {
                _check(
                    _has(targets[t], DEFAULT_ADMIN_ROLE, _admins[i]),
                    string.concat(names[t], " DEFAULT_ADMIN held by ", vm.toString(_admins[i]))
                );
            }
            for (uint256 i; i < _keepers.length; ++i) {
                _check(
                    _has(targets[t], KEEPER_ROLE, _keepers[i]),
                    string.concat(names[t], " KEEPER held by ", vm.toString(_keepers[i]))
                );
            }
        }
        for (uint256 i; i < _guardians.length; ++i) {
            _check(
                _has(_d.engine, GUARDIAN_ROLE, _guardians[i]),
                string.concat("engine GUARDIAN held by ", vm.toString(_guardians[i]))
            );
        }

        // AccessControl is not enumerable: check every known account against the expected holder lists.
        uint256 unexpected;
        for (uint256 c; c < _candidates.length; ++c) {
            address who = _candidates[c];
            for (uint256 t; t < 3; ++t) {
                if (_has(targets[t], DEFAULT_ADMIN_ROLE, who) && !_in(_admins, who)) {
                    _failed(string.concat(names[t], " unexpected DEFAULT_ADMIN holder ", vm.toString(who)));
                    ++unexpected;
                }
                if (_has(targets[t], KEEPER_ROLE, who) && !_in(_keepers, who)) {
                    _failed(string.concat(names[t], " unexpected KEEPER holder ", vm.toString(who)));
                    ++unexpected;
                }
            }
            if (_has(_d.engine, GUARDIAN_ROLE, who) && !_in(_guardians, who)) {
                _failed(string.concat("engine unexpected GUARDIAN holder ", vm.toString(who)));
                ++unexpected;
            }
        }
        if (unexpected == 0) {
            _passed(string.concat("no unexpected role holders among ", vm.toString(_candidates.length), " known accounts"));
        }
    }

    function _checkTimelock() private {
        if (_timelock == address(0)) return;
        _section("timelock");
        if (_timelock.code.length == 0) {
            _failed("TIMELOCK has no code");
            return;
        }
        TimelockController tl = TimelockController(payable(_timelock));
        uint256 minDelay = vm.envOr("MIN_TIMELOCK_DELAY", uint256(172_800));
        try tl.getMinDelay() returns (uint256 delay) {
            _check(delay >= minDelay, string.concat("timelock min delay ", vm.toString(delay), "s >= ", vm.toString(minDelay)));
        } catch {
            _failed("TIMELOCK is not a TimelockController");
            return;
        }
        _check(tl.hasRole(DEFAULT_ADMIN_ROLE, _timelock), "timelock administers itself");
        for (uint256 c; c < _candidates.length; ++c) {
            if (_candidates[c] != _timelock && tl.hasRole(DEFAULT_ADMIN_ROLE, _candidates[c])) {
                _failed(string.concat("timelock has an external admin ", vm.toString(_candidates[c])));
            }
        }
        if (_safe != address(0)) {
            _check(_safe.code.length != 0, "SAFE has code");
            _check(tl.hasRole(tl.PROPOSER_ROLE(), _safe), "SAFE is timelock proposer");
            _check(tl.hasRole(tl.EXECUTOR_ROLE(), _safe), "SAFE is timelock executor");
            _check(tl.hasRole(tl.CANCELLER_ROLE(), _safe), "SAFE is timelock canceller");
        }
        if (tl.hasRole(tl.EXECUTOR_ROLE(), address(0))) _warned("timelock execution is open to anyone");
    }

    function _checkGlobal() private {
        _section("global");
        ILemniscateEngine engine = ILemniscateEngine(_d.engine);
        uint16 maxGlobal = engine.maxGlobalExposureBps();
        uint16 feeShare = engine.protocolFeeShareBps();
        _check(
            maxGlobal >= 1_000 && maxGlobal <= BPS,
            string.concat("maxGlobalExposureBps ", vm.toString(maxGlobal), " in [1000, 10000]")
        );
        _check(feeShare <= 5_000, string.concat("protocolFeeShareBps ", vm.toString(feeShare), " <= 5000"));
        _check(!engine.globalBuysPaused(), "global buys not paused");

        address seq = address(engine.sequencerFeed());
        if (seq == address(0)) {
            if (vm.envOr("ALLOW_UNSET_SEQUENCER_FEED", false)) _warned("sequencerFeed unset (allowed by env)");
            else _failed("sequencerFeed unset (set ALLOW_UNSET_SEQUENCER_FEED=1 if the chain has no uptime feed)");
        } else {
            try IAggregatorV3(seq).latestRoundData() returns (uint80, int256 answer, uint256 startedAt, uint256, uint80) {
                _check(answer == 0, string.concat("sequencer feed reports up ", vm.toString(seq)));
                _check(
                    startedAt != 0 && block.timestamp >= startedAt + 1 hours,
                    "sequencer up for more than the 1h grace period"
                );
            } catch {
                _failed("sequencerFeed latestRoundData reverts");
            }
        }
    }

    function _checkVault() private {
        _section("vault");
        IWriterPool vault = IWriterPool(_d.vault);
        _check(vault.lockSeconds() <= 30 days, string.concat("lockSeconds ", vm.toString(vault.lockSeconds()), " <= 30d"));
        _check(vault.cashBufferBps() <= 5_000, string.concat("cashBufferBps ", vm.toString(vault.cashBufferBps()), " <= 5000"));
        uint16 hedgeRatio = vault.hedgeRatioBps();
        _check(
            hedgeRatio >= 5_000 && hedgeRatio <= 15_000,
            string.concat("hedgeRatioBps ", vm.toString(hedgeRatio), " in [5000, 15000]")
        );
        _check(
            vault.rebalanceThresholdBps() > 0 && vault.rebalanceThresholdBps() <= BPS,
            string.concat("rebalanceThresholdBps ", vm.toString(vault.rebalanceThresholdBps()), " in (0, 10000]")
        );
        _check(
            vault.maxHedgeSlippageBps() > 0 && vault.maxHedgeSlippageBps() <= 500,
            string.concat("maxHedgeSlippageBps ", vm.toString(vault.maxHedgeSlippageBps()), " in (0, 500]")
        );
        _check(
            vault.navGuardOpenBps() <= 2_000 && vault.navGuardClosedBps() <= 2_000
                && vault.navGuardOpenBps() <= vault.navGuardClosedBps(),
            string.concat(
                "navGuard open/closed ",
                vm.toString(vault.navGuardOpenBps()),
                "/",
                vm.toString(vault.navGuardClosedBps()),
                " <= 2000, open <= closed"
            )
        );
        if (vault.maxTotalDeposits() == 0) _warned("maxTotalDeposits is 0: deposits are closed");
        else _passed(string.concat("maxTotalDeposits ", vm.toString(vault.maxTotalDeposits())));

        try vault.navView() returns (int256 nav) {
            _check(nav > 0, string.concat("vault NAV positive (wad) ", vm.toString(nav)));
        } catch {
            _failed("vault navView reverts");
        }
        console2.log("  info: totalSupply", vault.totalSupply(), "navPerShareWad", vault.navPerShareWad());

        (bool ok, bytes memory ret) = _d.vault.staticcall(abi.encodeCall(IWriterPool.priceReference, ()));
        if (!ok || ret.length != 32) {
            _phaseIssue("priceReference() absent (implementation predates V2)");
        } else {
            address ref = abi.decode(ret, (address));
            if (ref == address(0)) _warned("priceReference unset: forced hedge sales use the oracle floor only");
            else _check(ref.code.length != 0, string.concat("priceReference set ", vm.toString(ref)));
        }
    }

    function _checkHours() private {
        _section("marketHours");
        IMarketHours mh = IMarketHours(_d.marketHours);
        try mh.currentSession() returns (bool openNow, uint64, uint64 close, uint64 nextOpen) {
            if (openNow) {
                _passed(string.concat("market open now, closes ", vm.toString(close)));
            } else if (nextOpen != 0) {
                _passed(string.concat("market closed, next session opens ", vm.toString(nextOpen)));
            } else {
                _warned("no current or future session pushed (keeper sessions job?)");
            }
        } catch {
            _failed("marketHours.currentSession reverts");
        }
    }

    function _checkMarkets() private {
        ILemniscateEngine engine = ILemniscateEngine(_d.engine);
        uint8 count = engine.marketCount();
        _section("markets");
        if (_d.markets.length != 0) {
            _check(
                count == _d.markets.length,
                string.concat("marketCount ", vm.toString(count), " == expected ", vm.toString(_d.markets.length))
            );
        } else {
            _warned("no expected market list: market addresses checked for consistency only");
        }

        address factory = uniswapFactory(_d.hedgeAdapter);
        if (factory == address(0)) _warned("Uniswap v3 factory not found (set UNISWAP_V3_FACTORY): pool checks skipped");
        address ref = _priceReference();
        uint256 window = 1_800;
        if (ref != address(0)) {
            try ITwapWindow(ref).window() returns (uint32 w) {
                window = w;
            } catch {}
        }
        uint256 minCardinality = vm.envOr("MIN_OBSERVATION_CARDINALITY", window + 1);
        bool open;
        try IMarketHours(_d.marketHours).isOpen(block.timestamp) returns (bool o) {
            open = o;
        } catch {}

        for (uint8 id; id < count; ++id) {
            _checkMarket(id, factory, ref, minCardinality, open);
        }
    }

    function _checkMarket(uint8 id, address factory, address ref, uint256 minCardinality, bool open) private {
        ILemniscateEngine engine = ILemniscateEngine(_d.engine);
        MarketConfig memory cfg = engine.getConfig(id);
        string memory tag = string.concat("market ", vm.toString(id), " ");
        string memory symbol = "";
        for (uint256 i; i < _d.markets.length; ++i) {
            if (_d.markets[i].id != id) continue;
            Market memory m = _d.markets[i];
            symbol = m.symbol;
            tag = string.concat(tag, m.symbol, " ");
            _check(address(cfg.token) == m.token, string.concat(tag, "token matches"));
            _check(address(cfg.stock) == m.stock, string.concat(tag, "stock matches"));
            _check(address(cfg.feed) == m.feed, string.concat(tag, "feed matches"));
            _check(uint256(cfg.scale) == m.scale, string.concat(tag, "scale matches"));
        }
        try engine.marketIdOf(address(cfg.token)) returns (uint8 back) {
            _check(back == id, string.concat(tag, "marketIdOf(token) round-trips"));
        } catch {
            _failed(string.concat(tag, "marketIdOf(token) reverts"));
        }

        _checkFeed(id, tag, symbol, cfg, open);

        if (cfg.offHoursBuyMaxAge == 0) {
            _phaseIssue(string.concat(tag, "offHoursBuyMaxAge is 0 (off-hours buys unlimited by feed age)"));
        } else {
            _passed(string.concat(tag, "offHoursBuyMaxAge ", vm.toString(cfg.offHoursBuyMaxAge), "s"));
        }
        MarketState memory st = engine.getState(id);
        if (st.buysPaused) _warned(string.concat(tag, "buys paused"));

        _checkRoute(id, tag, cfg, factory, ref, minCardinality, open);
    }

    function _checkFeed(uint8 id, string memory tag, string memory symbol, MarketConfig memory cfg, bool open) private {
        IAggregatorV3 feed = cfg.feed;
        try feed.decimals() returns (uint8 dec) {
            _check(dec == 8, string.concat(tag, "feed decimals 8"));
        } catch {
            _failed(string.concat(tag, "feed decimals() reverts"));
        }
        if (bytes(symbol).length != 0) {
            try IFeedDescription(address(feed)).description() returns (string memory desc) {
                _check(_contains(desc, symbol), string.concat(tag, "feed description '", desc, "'"));
            } catch {
                _warned(string.concat(tag, "feed has no description()"));
            }
        }

        uint256 maxAge = open ? cfg.maxAgeOpen : cfg.maxAgeOffHours;
        Regime regime = ILemniscateEngine(_d.engine).currentRegime(id);
        try feed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            uint256 age = block.timestamp > updatedAt ? block.timestamp - updatedAt : 0;
            bool fresh = answer > 0 && updatedAt != 0 && updatedAt <= block.timestamp && age <= maxAge;
            string memory msg_ = string.concat(
                tag,
                "feed age ",
                vm.toString(age),
                "s <= ",
                vm.toString(maxAge),
                open ? "s (open)" : "s (off-hours)",
                ", regime ",
                _regimeName(regime)
            );
            if (fresh && regime != Regime.PAUSED) {
                _passed(msg_);
            } else if (_expectedPaused(id) || vm.envOr("ALLOW_STALE_FEEDS", false)) {
                _warned(string.concat(msg_, " [expected]"));
            } else {
                _failed(msg_);
            }
        } catch {
            _failed(string.concat(tag, "feed latestRoundData reverts"));
        }
    }

    function _checkRoute(
        uint8 id,
        string memory tag,
        MarketConfig memory cfg,
        address factory,
        address ref,
        uint256 minCardinality,
        bool open
    ) private {
        (address adapter, uint24 fee) = _route(id);
        _check(adapter == _d.hedgeAdapter && adapter != address(0), string.concat(tag, "hedge adapter configured"));
        uint24 expectedFee;
        for (uint256 i; i < _d.markets.length; ++i) {
            if (_d.markets[i].id == id) expectedFee = _d.markets[i].poolFee;
        }
        if (expectedFee != 0) {
            _check(fee == expectedFee, string.concat(tag, "pool fee ", vm.toString(fee), " == expected"));
        } else {
            _check(fee != 0, string.concat(tag, "pool fee set ", vm.toString(fee)));
        }
        if (factory == address(0)) return;

        address pool = poolOf(factory, address(cfg.stock), _d.usdg, fee);
        if (pool == address(0)) {
            _failed(string.concat(tag, "no Uniswap v3 pool for stock/USDG at fee ", vm.toString(fee)));
            return;
        }
        (uint16 card, uint16 next) = cardinalityOf(pool);
        string memory cardMsg = string.concat(
            tag, "pool ", vm.toString(pool), " cardinality ", vm.toString(card), " (next ", vm.toString(next), ")"
        );
        if (card >= minCardinality) _passed(cardMsg);
        else _warned(string.concat(cardMsg, " < ", vm.toString(minCardinality)));
        try IUniswapV3PoolOps(pool).liquidity() returns (uint128 liq) {
            if (liq == 0) _warned(string.concat(tag, "pool has no in-range liquidity"));
        } catch {}

        if (ref == address(0)) return;
        uint256 twap;
        try IPriceReference(ref).referencePrice(address(cfg.stock), fee) returns (uint256 p) {
            twap = p;
        } catch {}
        if (twap == 0) {
            _warned(string.concat(tag, "TWAP reference unavailable (pool history shorter than the window?)"));
            return;
        }
        (uint256 spot,, bool valid) = ILemniscateEngine(_d.engine).spotPrice(id);
        uint256 dev = bpsDiff(twap, spot);
        uint256 maxDev = vm.envOr("MAX_TWAP_DEVIATION_BPS", uint256(500));
        string memory twapMsg = string.concat(
            tag, "TWAP ", vm.toString(twap), " vs feed ", vm.toString(spot), " (", vm.toString(dev), " bps)"
        );
        if (valid && dev <= maxDev) _passed(twapMsg);
        else if (!open) _warned(string.concat(twapMsg, " [off-hours]"));
        else _warned(twapMsg);
    }

    function _checkLens() private {
        _section("lens");
        ILemniscateLens lens = ILemniscateLens(_d.lens);
        uint8 count = ILemniscateEngine(_d.engine).marketCount();
        try lens.markets(ILemniscateEngine(_d.engine)) returns (MarketView[] memory views) {
            bool ok = views.length == count;
            for (uint256 i; ok && i < views.length; ++i) {
                ok = views[i].token == address(ILemniscateEngine(_d.engine).getConfig(uint8(i)).token);
            }
            _check(ok, string.concat("lens.markets(engine) returns ", vm.toString(views.length), " matching markets"));
        } catch {
            _failed("lens.markets(engine) reverts");
        }
        try lens.vault(ILemniscateEngine(_d.engine)) returns (VaultView memory v) {
            _check(v.totalSupply == IWriterPool(_d.vault).totalSupply(), "lens.vault(engine) matches the vault");
        } catch {
            _failed("lens.vault(engine) reverts");
        }
    }

    // ---------------------------------------------------------------- helpers

    function _priceReference() private view returns (address) {
        (bool ok, bytes memory ret) = _d.vault.staticcall(abi.encodeCall(IWriterPool.priceReference, ()));
        if (!ok || ret.length != 32) return address(0);
        return abi.decode(ret, (address));
    }

    function _route(uint8 id) private view returns (address adapter, uint24 fee) {
        (bool ok, bytes memory ret) = _d.vault.staticcall(abi.encodeCall(IWriterPool.routeForMarket, (id)));
        if (ok && ret.length == 64) (adapter, fee) = abi.decode(ret, (address, uint24));
    }

    function _expectedPaused(uint8 id) private view returns (bool) {
        uint256[] memory none = new uint256[](0);
        uint256[] memory ids = vm.envOr("EXPECT_PAUSED_MARKETS", ",", none);
        for (uint256 i; i < ids.length; ++i) {
            if (ids[i] == id) return true;
        }
        return false;
    }

    function _phaseIssue(string memory label) private {
        if (_post) _failed(label);
        else _warned(string.concat(label, " [pre-upgrade]"));
    }

    function _has(address target, bytes32 role, address who) private view returns (bool) {
        if (who == address(0)) return false;
        try ILemniscateEngine(target).hasRole(role, who) returns (bool held) {
            return held;
        } catch {
            return false;
        }
    }

    function _in(address[] storage list, address who) private view returns (bool) {
        for (uint256 i; i < list.length; ++i) {
            if (list[i] == who) return true;
        }
        return false;
    }

    function _addCandidates(address[] memory list) private {
        for (uint256 i; i < list.length; ++i) {
            _addCandidate(list[i]);
        }
    }

    function _addCandidate(address who) private {
        if (who == address(0) || _in(_candidates, who)) return;
        _candidates.push(who);
    }

    function _requireCode(string memory name, address target) private {
        _check(target != address(0) && target.code.length != 0, string.concat(name, " has code ", vm.toString(target)));
    }

    function _regimeName(Regime r) private pure returns (string memory) {
        if (r == Regime.OPEN) return "OPEN";
        if (r == Regime.OFF_HOURS) return "OFF_HOURS";
        return "PAUSED";
    }

    function _contains(string memory haystack, string memory needle) private pure returns (bool) {
        bytes memory h = bytes(haystack);
        bytes memory n = bytes(needle);
        if (n.length == 0 || h.length < n.length) return false;
        for (uint256 i; i <= h.length - n.length; ++i) {
            bool found = true;
            for (uint256 j; j < n.length; ++j) {
                if (h[i + j] != n[j]) {
                    found = false;
                    break;
                }
            }
            if (found) return true;
        }
        return false;
    }

    function _eq(string memory a, string memory b) private pure returns (bool) {
        return keccak256(bytes(a)) == keccak256(bytes(b));
    }

    function _section(string memory name) private pure {
        console2.log(string.concat("-- ", name));
    }

    function _check(bool ok, string memory label) private {
        if (ok) _passed(label);
        else _failed(label);
    }

    function _passed(string memory label) private {
        ++_pass;
        console2.log(string.concat("  [PASS] ", label));
    }

    function _warned(string memory label) private {
        ++_warn;
        console2.log(string.concat("  [WARN] ", label));
    }

    function _failed(string memory label) private {
        ++_fail;
        console2.log(string.concat("  [FAIL] ", label));
    }
}
