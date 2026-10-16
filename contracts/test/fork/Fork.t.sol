// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {SystemChecks} from "../../script/lib/SystemChecks.sol";
import {PriceGuard} from "../../src/PriceGuard.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {IStockToken} from "../../src/interfaces/IStockToken.sol";
import {PriceReading} from "../../src/libs/OptionTypes.sol";
import {MockKindHours} from "../mocks/PriceGuardMocks.sol";

/// @notice Todo 10 R5 (forkFeedsReadable) and the fork profile of the deploy script on real chain state.
/// Skipped unless `FORK_RPC_URL` is set. The launch names' addresses are NOT in this repo: they come from the fork
/// deploy config passed at run time (`DEPLOY_CONFIG` = path inside contracts/, or the JSON in `DEPLOY_CONFIG_JSON`).
///   FORK_RPC_URL=https://rpc.mainnet.chain.robinhood.com DEPLOY_CONFIG_JSON="$(cat <fork config>)" \
///     forge test --match-path test/fork/Fork.t.sol -vv
contract ForkTest is Test, SystemChecks {
    bool internal enabled;
    Config internal cfgStore;

    function setUp() public {
        string memory rpc = vm.envOr("FORK_RPC_URL", string(""));
        if (bytes(rpc).length == 0) return;
        enabled = true;
        vm.createSelectFork(rpc);
    }

    function _cfg() internal view returns (Config memory c) {
        c = loadConfig();
        require(c.profile == PROFILE_FORK, "Fork.t.sol: needs the fork profile config");
    }

    /// PriceGuard reads each launch name's real feed and Stock Token and returns a sane S, within 2% of the name's
    /// Uniswap v3 TWAP (the same pool the TWAP cross-check uses).
    function test_R5_forkFeedsReadable() public {
        if (!enabled) {
            vm.skip(true);
            return;
        }
        Config memory c = _cfg();
        address admin = makeAddr("admin");
        MockKindHours hours_ = new MockKindHours(); // REGULAR: the comparison needs a live reading
        PriceGuard g = new PriceGuard(admin, address(hours_), 24 hours, 1 hours);
        for (uint256 i; i < c.stocks.length; ++i) {
            StockCfg memory s = c.stocks[i];
            vm.startPrank(admin);
            g.setStock(
                s.stock,
                IPriceGuard.StockConfig({
                    feed: s.feed,
                    multiplierEmbedded: true,
                    // Fork relaxation (written in the runbook): off-hours the feeds do not print, so the age bound is
                    // widened here to read the last price; the comparison is about the value, not freshness.
                    maxAgeRegular: 30 days,
                    maxAgeExtended: 30 days,
                    continuityBps: s.continuityBps,
                    enabled: true
                })
            );
            g.setTwapSource(s.stock, s.uniPool, s.twapWindow, 2_000);
            vm.stopPrank();
            PriceReading memory r = g.read(s.stock);
            (uint256 twap,) = g.twapCheck(s.stock);
            uint256 ui = IStockToken(s.stock).uiMultiplier();
            emit log_named_string("name", s.name);
            emit log_named_decimal_uint("  S (feed, multiplier embedded)", r.s, 18);
            emit log_named_decimal_uint("  TWAP", twap, 18);
            emit log_named_decimal_uint("  uiMultiplier", ui, 18);
            emit log_named_uint("  feed age (s)", block.timestamp - r.updatedAt);
            assertGt(r.s, 1e18, "S above $1");
            assertLt(r.s, 100_000e18, "S below $100k");
            assertGt(ui, 0.5e18, "uiMultiplier sane");
            assertLt(ui, 2e18, "uiMultiplier sane");
            assertGt(twap, 0, "TWAP readable");
            uint256 diff = r.s > twap ? r.s - twap : twap - r.s;
            assertLe(diff * 10_000, twap * 200, "S within 2% of the TWAP");
        }
    }

    /// The deploy script's fork profile against real mainnet state (chain id set to 31337 as anvil would): every
    /// contract deployed, roles handed to the timelock, and the post-deploy check passes.
    function test_R1_deploySystemOnMainnetFork() public {
        if (!enabled) {
            vm.skip(true);
            return;
        }
        vm.chainId(CHAIN_FORK);
        Config memory c = _cfg();
        address deployer = makeAddr("fork-deployer");
        vm.startBroadcast(deployer);
        Deployed memory d = _deploySystem(c, deployer);
        vm.stopBroadcast();
        string[] memory fails = systemFailures(c, d);
        for (uint256 i; i < fails.length; ++i) {
            emit log_named_string("failure", fails[i]);
        }
        assertEq(fails.length, 0, "post-deploy check on the fork");
        assertEq(d.stocks.length, c.stocks.length);
    }
}
