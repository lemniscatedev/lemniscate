// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {LemniscateEngine} from "../../src/LemniscateEngine.sol";
import {WriterPool} from "../../src/WriterPool.sol";
import {Reserve} from "../../src/Reserve.sol";
import {FeeRouter} from "../../src/FeeRouter.sol";
import {PriceGuard} from "../../src/PriceGuard.sol";
import {VolOracle} from "../../src/VolOracle.sol";
import {SeriesRegistry} from "../../src/SeriesRegistry.sol";
import {MarketHours} from "../../src/MarketHours.sol";
import {AgentRouter} from "../../src/AgentRouter.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {IAggregatorV3} from "../../src/interfaces/IAggregatorV3.sol";
import {IHedgeAdapter} from "../../src/interfaces/IHedgeAdapter.sol";
import {SessionKind} from "../../src/libs/OptionTypes.sol";
import {SystemDeployer} from "./SystemDeployer.sol";
import {VaultRegistry} from "../../src/vaults/VaultRegistry.sol";
import {WriterVault} from "../../src/vaults/WriterVault.sol";

/// @title SystemChecks
/// @notice The post-deploy check (todo 10 R3): every failure is a named reason, so a misconfiguration says what is
/// wrong. Used by PostDeployCheck.s.sol on a live deployment and by the system tests on a fresh one.
abstract contract SystemChecks is SystemDeployer {
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc; // not-a-key
    bytes32 internal constant INITIALIZABLE_SLOT = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00; // not-a-key

    string[] private _fails;

    /// @notice Every failed check of deployment `d` against config `c` (empty = pass).
    function systemFailures(Config memory c, Deployed memory d) internal returns (string[] memory out) {
        delete _fails;
        _checkChain(c, d);
        if (_fails.length != 0) return _fails; // wrong chain: nothing else is meaningful
        _checkCode(d);
        if (_fails.length != 0) return _fails;
        _checkWiring(d);
        _checkAdmin(c, d);
        _checkRoles(c, d);
        _checkTimers(c, d);
        _checkStocks(c, d);
        _checkPool(c, d);
        _checkVaults(c, d);
        out = _fails;
    }

    function _fail(string memory reason) private {
        _fails.push(reason);
    }

    function _failIf(bool bad, string memory reason) private {
        if (bad) _fails.push(reason);
    }

    // ------------------------------------------------------------------------------------------------- checks

    function _checkChain(Config memory c, Deployed memory d) private {
        _failIf(block.chainid != chainOf(c.profile) || d.chainId != block.chainid, "CHAIN_ID_MISMATCH");
    }

    function _checkCode(Deployed memory d) private {
        address[13] memory a = [
            d.engine, d.pool, d.registry, d.priceGuard, d.volOracle, d.usdg, d.marketHours, d.agentRouter, d.reserve,
            d.feeRouter, d.hedgeAdapter, d.engineImpl, d.poolImpl
        ];
        string[13] memory n = [
            "engine", "pool", "registry", "priceGuard", "volOracle", "usdg", "marketHours", "agentRouter", "reserve",
            "feeRouter", "hedgeAdapter", "engineImpl", "poolImpl"
        ];
        for (uint256 i; i < a.length; ++i) {
            _failIf(a[i].code.length == 0, string.concat("NO_CODE:", n[i]));
        }
    }

    function _checkWiring(Deployed memory d) private {
        LemniscateEngine e = LemniscateEngine(d.engine);
        _failIf(
            address(e.pool()) != d.pool || address(e.registry()) != d.registry || address(e.priceGuard()) != d.priceGuard
                || address(e.volOracle()) != d.volOracle || address(e.usdg()) != d.usdg,
            "ENGINE_WIRING"
        );
        WriterPool p = WriterPool(d.pool);
        _failIf(
            address(p.engine()) != d.engine || address(p.reserve()) != d.reserve || address(p.feeRouter()) != d.feeRouter
                || address(p.priceGuard()) != d.priceGuard || address(p.usdg()) != d.usdg,
            "POOL_WIRING"
        );
        _failIf(address(p.priceReference()) != d.priceReference, "POOL_PRICE_REFERENCE");
        _failIf(SeriesRegistry(d.registry).engine() != d.engine, "REGISTRY_ENGINE");
        _failIf(address(SeriesRegistry(d.registry).priceGuard()) != d.priceGuard, "REGISTRY_PRICE_GUARD");
        _failIf(Reserve(d.reserve).pool() != d.pool, "RESERVE_POOL");
        _failIf(FeeRouter(d.feeRouter).pool() != d.pool, "FEE_ROUTER_POOL");
        _failIf(address(PriceGuard(d.priceGuard).marketHours()) != d.marketHours, "PRICE_GUARD_MARKET_HOURS");
        _failIf(AgentRouter(d.agentRouter).engine() != d.engine, "AGENT_ROUTER_ENGINE");
        _failIf(e.agentRouter() != d.agentRouter, "ENGINE_AGENT_ROUTER");
        // Review fixes (todo 27): the $1 minimum trade, the 30-minute hold and the 7-day settle delay stay on.
        (uint64 minTrade, uint32 hold, uint32 settleDelay) = e.guards();
        _failIf(minTrade < 1e6 || hold < 30 minutes || settleDelay < 7 days, "TRADE_GUARDS");
        _failIf(PriceGuard(d.priceGuard).maxAgeClosed() != 0, "MAX_AGE_CLOSED_NOT_DEFAULT");
        _failIf(_impl(d.engine) != d.engineImpl || _impl(d.pool) != d.poolImpl, "IMPLEMENTATION_MISMATCH");
        _failIf(
            !_initLocked(d.engineImpl) || !_initLocked(d.poolImpl)
                || (d.marketHoursImpl != address(0) && !_initLocked(d.marketHoursImpl)),
            "IMPL_INITIALIZER_OPEN"
        );
    }

    function _checkAdmin(Config memory c, Deployed memory d) private {
        address[] memory t = adminTargets(d);
        bool testnet = c.profile == PROFILE_TESTNET;
        address expected = testnet ? c.roles.owner : d.timelock;
        for (uint256 i; i < t.length; ++i) {
            IAccessControl a = IAccessControl(t[i]);
            if (expected == address(0) || !a.hasRole(ADMIN, expected)) {
                _fail(testnet ? "ADMIN_NOT_OWNER" : "ADMIN_NOT_TIMELOCK");
                break;
            }
        }
        for (uint256 i; i < t.length; ++i) {
            if (IAccessControl(t[i]).hasRole(ADMIN, d.deployer)) {
                _fail("EOA_ADMIN_LEFT"); // the deployer still administers a contract
                break;
            }
        }
        if (testnet) {
            // The owner administers directly (no timelock on testnet): it must be a real Safe unless ALLOW_EOA_OWNER=1.
            string memory problem = ownerSafeProblem(c.roles.owner, c.safeSingletons, c.allowEoaOwner);
            if (bytes(problem).length != 0) _fail(problem);
            return;
        }

        address tlAddr = d.timelock;
        if (tlAddr.code.length == 0) {
            _fail("TIMELOCK_MISSING");
            return;
        }
        TimelockController tl = TimelockController(payable(tlAddr));
        _failIf(tl.getMinDelay() < FULL_TIMELOCK_DELAY, "TIMELOCK_DELAY_SHORT");
        address safe = d.safe;
        // Timelock owner: a Safe (any contract on fork, >= 3-of-5 on mainnet), or a plain EOA only with ALLOW_EOA_OWNER=1
        // (owner decision 2026-10-28). The EOA must still have no code: an EIP-7702 delegation is always a failure, also
        // when it appears after the deploy (its delegate could act for the owner, or sweep it).
        if (isDelegatedEoa(safe)) {
            _fail("OWNER_IS_DELEGATED_EOA");
        } else if (safe.code.length == 0) {
            _failIf(!c.allowEoaOwner || safe == address(0), "SAFE_NOT_CONTRACT");
        } else if (c.profile == PROFILE_MAINNET) {
            _failIf(
                _safeThreshold(safe) < MAINNET_SAFE_MIN_THRESHOLD || _safeOwners(safe) < MAINNET_SAFE_MIN_OWNERS,
                "SAFE_BELOW_3_OF_5"
            );
        }
        _failIf(safe == d.deployer, "DEPLOYER_OWNS_TIMELOCK");
        _failIf(c.roles.safe != address(0) && safe != c.roles.safe, "TIMELOCK_OWNER_MISMATCH");
        Roles memory r = c.roles;
        _failIf(safe == r.keeper || safe == r.hedger || safe == r.volSigner, "OWNER_IS_BOT");
        _failIf(safe == r.guardian, "OWNER_IS_GUARDIAN");
        _failIf(
            !tl.hasRole(tl.PROPOSER_ROLE(), safe) || !tl.hasRole(tl.EXECUTOR_ROLE(), safe)
                || !tl.hasRole(tl.CANCELLER_ROLE(), safe),
            "TIMELOCK_NOT_SAFE"
        );
        _failIf(tl.hasRole(tl.EXECUTOR_ROLE(), address(0)), "TIMELOCK_OPEN_EXECUTION");
        _failIf(
            !tl.hasRole(ADMIN, tlAddr) || tl.hasRole(ADMIN, d.deployer) || tl.hasRole(ADMIN, safe),
            "TIMELOCK_NOT_SELF_ADMINISTERED"
        );
        // Nothing but the timelock may administer: the Safe, the guardian and the bots go through it.
        for (uint256 i; i < t.length; ++i) {
            IAccessControl a = IAccessControl(t[i]);
            if (a.hasRole(ADMIN, safe)) {
                _fail("SAFE_BYPASSES_TIMELOCK");
                break;
            }
        }
        // The deployer keeps no timelock role either (it could otherwise schedule, execute or cancel admin actions).
        _failIf(
            tl.hasRole(tl.PROPOSER_ROLE(), d.deployer) || tl.hasRole(tl.EXECUTOR_ROLE(), d.deployer)
                || tl.hasRole(tl.CANCELLER_ROLE(), d.deployer),
            "DEPLOYER_HOLDS_TIMELOCK_ROLE"
        );
    }

    function _checkRoles(Config memory c, Deployed memory d) private {
        Roles memory r = c.roles;
        _failIf(r.keeper == r.hedger || r.keeper == r.volSigner || r.hedger == r.volSigner, "BOTS_NOT_SEPARATED");
        address signer = VolOracle(d.volOracle).signer();
        _failIf(signer != r.volSigner, "VOL_SIGNER_MISMATCH");
        _failIf(signer == r.keeper || signer == r.hedger, "SIGNER_IS_BOT");
        _failIf(
            !IAccessControl(d.registry).hasRole(KEEPER, r.keeper) || !IAccessControl(d.marketHours).hasRole(KEEPER, r.keeper),
            "KEEPER_ROLE_MISSING"
        );
        _failIf(!IAccessControl(d.pool).hasRole(HEDGER, r.hedger), "HEDGER_ROLE_MISSING");
        // F03/F17: no perp venue at launch, so the hedger can post no equity at all (cap 0 = perps off).
        (uint16 perpBps,,,) = WriterPool(d.pool).hedgerLimits();
        _failIf(perpBps != 0, "PERP_EQUITY_ON");
        _failIf(!IAccessControl(d.engine).hasRole(GUARDIAN, r.keeper), "KEEPER_GUARDIAN_MISSING");
        _failIf(
            !IAccessControl(d.engine).hasRole(GUARDIAN, r.guardian) || !IAccessControl(d.pool).hasRole(GUARDIAN, r.guardian)
                || !IAccessControl(d.priceGuard).hasRole(GUARDIAN, r.guardian)
                || !IAccessControl(d.volOracle).hasRole(GUARDIAN, r.guardian),
            "GUARDIAN_ROLE_MISSING"
        );
        address[] memory t = adminTargets(d);
        address[4] memory bots = [r.guardian, r.keeper, r.hedger, r.volSigner];
        string[4] memory names = ["GUARDIAN_HAS_ADMIN", "KEEPER_HAS_ADMIN", "HEDGER_HAS_ADMIN", "SIGNER_HAS_ADMIN"];
        for (uint256 b; b < bots.length; ++b) {
            for (uint256 i; i < t.length; ++i) {
                if (IAccessControl(t[i]).hasRole(ADMIN, bots[b])) {
                    _fail(names[b]);
                    break;
                }
            }
        }
        bool deployerRole = IAccessControl(d.registry).hasRole(KEEPER, d.deployer)
            || IAccessControl(d.marketHours).hasRole(KEEPER, d.deployer) || IAccessControl(d.pool).hasRole(HEDGER, d.deployer)
            || IAccessControl(d.engine).hasRole(GUARDIAN, d.deployer) || IAccessControl(d.pool).hasRole(GUARDIAN, d.deployer)
            || IAccessControl(d.priceGuard).hasRole(GUARDIAN, d.deployer)
            || IAccessControl(d.volOracle).hasRole(GUARDIAN, d.deployer);
        _failIf(deployerRole && d.deployer != r.keeper && d.deployer != r.hedger && d.deployer != r.guardian, "DEPLOYER_HOLDS_ROLE");

        FeeRouter f = FeeRouter(d.feeRouter);
        _failIf(
            f.treasury() != r.treasury || (r.keepersPot != address(0) && f.keepersPot() != r.keepersPot)
                || (r.hedgerPot != address(0) && f.hedgerPot() != r.hedgerPot),
            "FEE_RECIPIENT"
        );
    }

    function _checkTimers(Config memory c, Deployed memory d) private {
        Timers memory w = c.timers; // fork/mainnet: the full values (SystemConfig refuses shorter ones)
        _failIf(WriterPool(d.pool).QUEUE_DELAY() != w.poolQueueDelay, "TIMER:poolQueueDelay");
        _failIf(WriterPool(d.pool).lockSeconds() != w.depositLock, "TIMER:depositLock");
        _failIf(FeeRouter(d.feeRouter).PERIOD() != w.feePeriod, "TIMER:feePeriod");
        _failIf(VolOracle(d.volOracle).MAX_VALIDITY() != w.volMaxValidity, "TIMER:volMaxValidity");
        _failIf(VolOracle(d.volOracle).MIN_POST_INTERVAL() != w.volMinPostInterval, "TIMER:volMinPostInterval");
        _failIf(PriceGuard(d.priceGuard).SPLIT_LEAD() != w.splitLead, "TIMER:splitLead");
        _failIf(PriceGuard(d.priceGuard).SPLIT_TAIL() != w.splitTail, "TIMER:splitTail");
    }

    function _checkStocks(Config memory c, Deployed memory d) private {
        PriceGuard g = PriceGuard(d.priceGuard);
        SeriesRegistry reg = SeriesRegistry(d.registry);
        WriterPool p = WriterPool(d.pool);
        _failIf(d.stocks.length != c.stocks.length, "STOCK_COUNT");
        SessionKind kind = MarketHours(d.marketHours).kindAt(block.timestamp);
        bool open = kind == SessionKind.REGULAR || kind == SessionKind.EXTENDED;
        for (uint256 i; i < d.stocks.length && i < c.stocks.length; ++i) {
            address stock = d.stocks[i];
            string memory tag = string.concat(":", d.names[i]);
            IPriceGuard.StockConfig memory cfg;
            try g.config(stock) returns (IPriceGuard.StockConfig memory got) {
                cfg = got;
            } catch {
                _fail(string.concat("STOCK_NOT_CONFIGURED", tag));
                continue;
            }
            _failIf(!cfg.enabled || cfg.feed != d.feeds[i], string.concat("STOCK_NOT_CONFIGURED", tag));
            _failIf(!cfg.multiplierEmbedded, string.concat("MULTIPLIER_NOT_EMBEDDED", tag));
            _failIf(!reg.allowedStock(stock), string.concat("STOCK_NOT_ALLOWED", tag));
            (address adapter,) = _route(p, stock);
            _failIf(adapter != d.hedgeAdapter, string.concat("HEDGE_ROUTE_MISSING", tag));
            if (c.profile != PROFILE_TESTNET) {
                _failIf(g.twapSource(stock).pool != c.stocks[i].uniPool, string.concat("TWAP_MISSING", tag));
                _failIf(
                    g.twapSource(stock).bandBps != c.stocks[i].twapBandBps, string.concat("TWAP_BAND", tag)
                );
                // Audit M-2: the pool's observation ring must cover the longest TWAP window plus a margin (Uniswap writes
                // at most one observation per second), or a dust-swap refill can erase the worse-of trade TWAP.
                _failIf(
                    _cardinality(c.stocks[i].uniPool) < MIN_TWAP_CARDINALITY,
                    string.concat("TWAP_CARDINALITY", tag)
                );
                _failIf(
                    LemniscateEngine(d.engine).hedgeDepthCapWad(stock) != c.stocks[i].hedgeDepthCapUsd * 1e18,
                    string.concat("DEPTH_CAP", tag)
                );
            }
            // Feed age: a feed older than its own maxAge inside a session (REGULAR / EXTENDED) is stale. Outside a
            // session the feeds legitimately do not print (chain-facts), so age is only reported, not failed.
            (bool ok, uint256 updatedAt) = _feedUpdatedAt(d.feeds[i]);
            uint256 maxAge = kind == SessionKind.EXTENDED ? cfg.maxAgeExtended : cfg.maxAgeRegular;
            if (!ok) _fail(string.concat("FEED_UNREADABLE", tag));
            else if (open && block.timestamp > updatedAt + maxAge) _fail(string.concat("FEED_STALE", tag));
            if (open) _failIf(g.readLite(stock).s == 0, string.concat("PRICE_UNREADABLE", tag));
        }
    }

    /// @dev Audit M-2: MAX_TRADE_TWAP_WINDOW (30 min) of one-per-second observations plus a 20% margin.
    uint256 internal constant MIN_TWAP_CARDINALITY = 2_160;

    function _cardinality(address pool) private view returns (uint256) {
        (bool ok, bytes memory r) = pool.staticcall(abi.encodeWithSignature("slot0()"));
        if (!ok || r.length < 224) return 0;
        (,,, uint16 card) = abi.decode(r, (uint160, int24, uint16, uint16));
        return card;
    }

    function _checkPool(Config memory c, Deployed memory d) private {
        WriterPool p = WriterPool(d.pool);
        _failIf(p.publicDeposits() != c.limits.publicDeposits, "POOL_ALLOWLIST_OFF");
        for (uint256 i; i < c.roles.depositors.length; ++i) {
            if (!p.isDepositor(c.roles.depositors[i])) {
                _fail("DEPOSITOR_MISSING");
                break;
            }
        }
        (bool global,,, bool frozen) = LemniscateEngine(d.engine).flags();
        _failIf(global, "ENGINE_BUYS_PAUSED");
        _failIf(frozen, "ENGINE_UPGRADES_FROZEN");
        _failIf(p.depositsPaused(), "POOL_DEPOSITS_PAUSED");
    }

    // -------------------------------------------------------------------------------------------- low level

    function _route(WriterPool p, address stock) private view returns (address adapter, uint24 fee) {
        try p.routeOf(stock) returns (IHedgeAdapter a, uint24 f) {
            return (address(a), f);
        } catch {}
    }

    function _feedUpdatedAt(address feed) private view returns (bool ok, uint256 updatedAt) {
        try IAggregatorV3(feed).latestRoundData() returns (uint80, int256 answer, uint256, uint256 at, uint80) {
            return (answer > 0, at);
        } catch {}
    }

    function _impl(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPLEMENTATION_SLOT))));
    }

    function _initLocked(address impl) internal view returns (bool) {
        return uint64(uint256(vm.load(impl, INITIALIZABLE_SLOT))) == type(uint64).max;
    }

    /// @dev Todo 19: vaults off unless the flag is on; when on, wired to this pool and every vault closed on its epoch.
    /// Todo 20: the $LMNS modules are never wired by this deploy (DeployLmns does it later): no staking loss layer on the
    /// pool and no fee-tier contract on the engine.
    function _checkVaults(Config memory c, Deployed memory d) private {
        _failIf(
            address(WriterPool(d.pool).staking()) != address(0) || LemniscateEngine(d.engine).feeTiers() != address(0),
            "LMNS_NOT_OFF"
        );
        address hook = WriterPool(d.pool).vaultHook();
        if (!c.vaults.enabled) {
            _failIf(hook != address(0), "VAULTS_NOT_OFF");
            return;
        }
        _failIf(hook == address(0) || hook != d.vaultRegistry, "VAULT_HOOK");
        if (d.vaultRegistry.code.length == 0) return;
        VaultRegistry reg = VaultRegistry(d.vaultRegistry);
        _failIf(reg.pool() != d.pool || reg.vaultCount() != d.vaults.length, "VAULT_REGISTRY_WIRING");
        _failIf(!reg.hasRole(reg.ALLOCATOR_ROLE(), c.roles.keeper), "VAULT_ALLOCATOR");
        for (uint256 i; i < d.vaults.length; ++i) {
            WriterVault v = WriterVault(d.vaults[i]);
            _failIf(v.open(), "VAULT_OPEN");
            _failIf(v.EPOCH() != c.vaults.epoch, "TIMER:vaultEpoch");
            _failIf(!reg.isVault(address(v)) || v.registry() != d.vaultRegistry, "VAULT_NOT_REGISTERED");
        }
    }

    // ------------------------------------------------------------------------------------------- file input

    /// @notice Reads a deployment file written by DeploySystem (deploymentJson).
    function parseDeployment(string memory json) internal view returns (Deployed memory d) {
        d.chainId = vm.parseJsonUint(json, ".chainId");
        d.network = vm.parseJsonString(json, ".network");
        d.deployBlock = vm.parseJsonUint(json, ".deployBlock");
        d.deployer = vm.parseJsonAddress(json, ".deployer");
        d.admin = vm.parseJsonAddress(json, ".admin");
        d.safe = vm.parseJsonAddress(json, ".safe");
        d.engine = vm.parseJsonAddress(json, ".contracts.engine");
        d.pool = vm.parseJsonAddress(json, ".contracts.pool");
        d.registry = vm.parseJsonAddress(json, ".contracts.registry");
        d.priceGuard = vm.parseJsonAddress(json, ".contracts.priceGuard");
        d.volOracle = vm.parseJsonAddress(json, ".contracts.volOracle");
        d.usdg = vm.parseJsonAddress(json, ".contracts.usdg");
        d.marketHours = vm.parseJsonAddress(json, ".contracts.marketHours");
        d.agentRouter = vm.parseJsonAddress(json, ".contracts.agentRouter");
        d.reserve = vm.parseJsonAddress(json, ".contracts.reserve");
        d.feeRouter = vm.parseJsonAddress(json, ".contracts.feeRouter");
        d.hedgeAdapter = vm.parseJsonAddress(json, ".contracts.hedgeAdapter");
        d.priceReference = vm.parseJsonAddress(json, ".contracts.priceReference");
        d.swapRouter = vm.parseJsonAddress(json, ".contracts.swapRouter");
        d.engineImpl = vm.parseJsonAddress(json, ".contracts.engineImpl");
        d.poolImpl = vm.parseJsonAddress(json, ".contracts.poolImpl");
        d.marketHoursImpl = vm.parseJsonAddress(json, ".contracts.marketHoursImpl");
        d.timelock = vm.parseJsonAddress(json, ".contracts.timelock");
        if (vm.keyExistsJson(json, ".contracts.vaultRegistry")) {
            d.vaultRegistry = vm.parseJsonAddress(json, ".contracts.vaultRegistry");
            if (d.vaultRegistry != address(0)) {
                VaultRegistry reg = VaultRegistry(d.vaultRegistry);
                uint256 nv = reg.vaultCount();
                d.vaults = new address[](nv);
                for (uint256 i; i < nv; ++i) {
                    d.vaults[i] = reg.vaults(i);
                }
            }
        }
        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".stocks[", vm.toString(n), "]"))) ++n;
        d.names = new string[](n);
        d.stocks = new address[](n);
        d.feeds = new address[](n);
        for (uint256 i; i < n; ++i) {
            string memory p = string.concat(".stocks[", vm.toString(i), "]");
            d.names[i] = vm.parseJsonString(json, string.concat(p, ".name"));
            d.stocks[i] = vm.parseJsonAddress(json, string.concat(p, ".stock"));
            d.feeds[i] = vm.parseJsonAddress(json, string.concat(p, ".feed"));
        }
    }
}
