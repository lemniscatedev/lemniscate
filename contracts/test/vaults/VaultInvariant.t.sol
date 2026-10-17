// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {VaultFixture} from "./VaultFixture.sol";
import {WriterVault} from "../../src/vaults/WriterVault.sol";
import {VaultRegistry} from "../../src/vaults/VaultRegistry.sol";

/// @dev Drives the real system with vaults: buys, sells, price moves, time, slices assumed and released, deposits,
/// withdrawal requests, rolls and claims. Records panics (0x4e487b71) and the ghost flows of the call vault's Stock
/// Tokens (deposited, claimed out).
contract VaultHandler is Test {
    VaultInvariantTest internal t;
    bytes32[] public ids;
    uint256 public panics;
    uint256 public stockDeposited;
    uint256 public stockClaimed;
    uint256 public calls;
    mapping(bytes32 action => uint256) public ok;

    constructor(VaultInvariantTest t_, bytes32[] memory ids_) {
        t = t_;
        ids = ids_;
    }

    function seed(uint256 deposited) external {
        if (msg.sender != address(t)) return; // fuzzer calls are no-ops
        stockDeposited += deposited;
    }

    function _catch(bytes memory err) internal {
        if (err.length >= 4 && bytes4(err) == bytes4(0x4e487b71)) ++panics;
    }

    function _vault(uint256 seed) internal view returns (WriterVault) {
        return seed % 2 == 0 ? WriterVault(address(t.upV())) : WriterVault(address(t.downV()));
    }

    function _actor(uint256 seed) internal view returns (address) {
        return seed % 2 == 0 ? t.bobA() : t.carolA();
    }

    function buy(uint256 seed, uint256 units) external {
        ++calls;
        try t.hBuy(ids[seed % ids.length], bound(units, 1e16, 5e18)) {
            ++ok["buy"];
        } catch (bytes memory e) {
            _catch(e);
        }
    }

    function sell(uint256 seed, uint256 bps) external {
        ++calls;
        try t.hSell(ids[seed % ids.length], bound(bps, 1, 10_000)) {
            ++ok["sell"];
        } catch (bytes memory e) {
            _catch(e);
        }
    }

    function move(uint256 bps, bool goUp) external {
        ++calls;
        try t.hMove(bound(bps, 0, 2_000), goUp) {} catch (bytes memory e) {
            _catch(e);
        }
    }

    function time(uint256 secs) external {
        ++calls;
        try t.hTime(bound(secs, 1, 2 days)) {} catch (bytes memory e) {
            _catch(e);
        }
    }

    function assume(uint256 seed, uint256 bps) external {
        ++calls;
        try t.hAssume(ids[seed % ids.length], bound(bps, 1, 10_000)) {
            ++ok["assume"];
        } catch (bytes memory e) {
            _catch(e);
        }
    }

    function release(uint256 seed, uint256 bps) external {
        ++calls;
        try t.hRelease(ids[seed % ids.length], bound(bps, 1, 10_000)) {
            ++ok["release"];
        } catch (bytes memory e) {
            _catch(e);
        }
    }

    function deposit(uint256 seed, uint256 amount) external {
        ++calls;
        WriterVault v = _vault(seed);
        address who = _actor(seed >> 1);
        amount = v.isCallVault() ? bound(amount, 1e15, 20e18) : bound(amount, 1e6, 2_000e6);
        try t.hDeposit(v, who, amount) {
            if (v.isCallVault()) stockDeposited += amount;
        } catch (bytes memory e) {
            _catch(e);
        }
    }

    function withdraw(uint256 seed, uint256 bps) external {
        ++calls;
        WriterVault v = _vault(seed);
        try t.hWithdraw(v, _actor(seed >> 1), bound(bps, 1, 10_000)) returns (uint256 coll) {
            if (v.isCallVault()) stockClaimed += coll;
        } catch (bytes memory e) {
            _catch(e);
        }
    }

    function roll(uint256 seed) external {
        ++calls;
        try t.hRoll(_vault(seed)) {
            ++ok["roll"];
        } catch (bytes memory e) {
            _catch(e);
        }
    }

    function claim(uint256 seed) external {
        ++calls;
        WriterVault v = _vault(seed);
        try t.hClaim(v, _actor(seed >> 1)) returns (uint256 coll) {
            if (v.isCallVault()) stockClaimed += coll;
        } catch (bytes memory e) {
            _catch(e);
        }
    }
}

/// @notice Todo 19 R7 invariants on the real system: value conservation (every Stock Token that entered the call
/// vault is in the vault, at the pool or claimed out; tracked buckets never exceed balances), coverage within supply,
/// locked collateral within active collateral, no dangling approvals, no USDG stranded in the registry, no panics.
contract VaultInvariantTest is VaultFixture {
    VaultHandler internal handler;
    bytes32[] internal ids;
    uint256 internal poolStock0;

    function setUp() public {
        _deployVaults();
        _open();
        ids.push(_list(0, true, 110e18, WEEKLY));
        ids.push(_list(0, true, 130e18, WEEKLY));
        ids.push(_list(0, false, 90e18, WEEKLY));
        ids.push(_list(0, false, 70e18, WEEKLY));
        for (uint256 i; i < ids.length; ++i) {
            _buy(alice, ids[i], 10e18);
        }
        // Both vaults start funded (rolled once) so slices can be assumed from the first call.
        _vdeposit(up, bob, 40e18);
        _vdeposit(down, bob, 4_000e6);
        _roll(up);
        down.roll();
        _claim(up, bob);
        _claim(down, bob);
        poolStock0 = stocks[0].balanceOf(address(pool));
        handler = new VaultHandler(this, ids);
        handler.seed(40e18);
        // The handler calls back into this contract (pranks need the test's cheatcode context).
        targetContract(address(handler));
    }

    // ------------------------------------------------------------------------------- handler entry points

    function upV() external view returns (WriterVault) {
        return up;
    }

    function downV() external view returns (WriterVault) {
        return down;
    }

    function bobA() external view returns (address) {
        return bob;
    }

    function carolA() external view returns (address) {
        return carol;
    }

    function hBuy(bytes32 id, uint256 units) external {
        _fresh();
        _buy(alice, id, units);
    }

    function hSell(bytes32 id, uint256 bps) external {
        _refreshVols();
        uint256 tokens = _token(id).balanceOf(alice) * bps / 10_000;
        if (tokens != 0) _sell(alice, id, tokens);
    }

    function hMove(uint256 bps, bool goUp) external {
        uint256 s = px[0];
        uint256 d = s * bps / 10_000;
        uint256 next = goUp ? s + d : s - d;
        if (next < 20e18) next = 20e18;
        if (next > 500e18) next = 500e18;
        _setPrice(0, next);
    }

    function hTime(uint256 secs) external {
        skip(secs);
        _fresh();
    }

    function hAssume(bytes32 id, uint256 bps) external {
        WriterVault v = registry.seriesOf(id).isCall ? WriterVault(address(up)) : WriterVault(address(down));
        uint256 room = _token(id).totalSupply() - vreg.coveredTokens(id);
        uint256 tokens = room * bps / 10_000;
        if (tokens == 0) return;
        _assume(v, id, tokens);
    }

    function hRelease(bytes32 id, uint256 bps) external {
        WriterVault v = registry.seriesOf(id).isCall ? WriterVault(address(up)) : WriterVault(address(down));
        uint256 tokens = vreg.sliceOf(address(v), id) * bps / 10_000;
        if (tokens == 0) return;
        vm.prank(keeper);
        vreg.release(address(v), id, tokens);
    }

    function hDeposit(WriterVault v, address who, uint256 amount) external {
        _vdeposit(v, who, amount);
    }

    /// @dev Claims what is processed (returns the collateral claimed), then queues `bps` of the actor's shares.
    function hWithdraw(WriterVault v, address who, uint256 bps) external returns (uint256 coll) {
        (uint256 sh, uint256 c, uint256 u) = v.claimable(who);
        if (sh != 0 || c != 0 || u != 0) (, coll,) = _claim(v, who);
        uint256 shares = v.balanceOf(who) * bps / 10_000;
        if (shares == 0) return coll;
        vm.prank(who);
        v.requestWithdraw(shares);
    }

    function hRoll(WriterVault v) external {
        _roll(v);
    }

    function hClaim(WriterVault v, address who) external returns (uint256 coll) {
        (, coll,) = _claim(v, who);
    }

    // ---------------------------------------------------------------------------------------- invariants

    function invariant_R7_noPanics() public view {
        assertEq(handler.panics(), 0);
    }

    function invariant_R7_coverageWithinSupply() public view {
        for (uint256 i; i < ids.length; ++i) {
            assertLe(vreg.coveredTokens(ids[i]), _token(ids[i]).totalSupply());
            assertEq(
                vreg.coveredTokens(ids[i]),
                vreg.sliceOf(address(up), ids[i]) + vreg.sliceOf(address(down), ids[i]),
                "book adds up"
            );
        }
    }

    function invariant_R7_lockedWithinCollateral() public view {
        assertLe(vreg.lockedOf(address(up)), up.collateral());
        assertLe(vreg.lockedOf(address(down)), down.collateral());
    }

    function invariant_R7_bucketsBackedByBalances() public view {
        assertGe(
            stocks[0].balanceOf(address(up)),
            up.collateral() + up.pendingAssets() + up.reservedCollateral() + up.debt(),
            "call vault Stock Tokens"
        );
        assertGe(usdg.balanceOf(address(up)), up.fundingReceived() + up.reservedUsdg(), "call vault USDG");
        assertGe(
            usdg.balanceOf(address(down)),
            down.collateral() + down.pendingAssets() + down.reservedCollateral() + down.debt(),
            "put vault USDG"
        );
        assertEq(down.fundingReceived(), 0);
        assertEq(usdg.balanceOf(address(vreg)), 0, "nothing stranded in the registry");
        assertGe(up.totalSupply(), up.pendingShares());
    }

    function invariant_R7_stockConservation() public view {
        // in = vault balance + paid to the pool + claimed out (the pool only gains Stock Tokens from the vault here; the
        // actors hold Stock Tokens only from claims, which also happen inside deposit and requestWithdraw)
        assertEq(
            handler.stockDeposited(),
            stocks[0].balanceOf(address(up)) + (stocks[0].balanceOf(address(pool)) - poolStock0)
                + stocks[0].balanceOf(bob) + stocks[0].balanceOf(carol)
        );
        assertEq(stocks[0].balanceOf(address(pool)) - poolStock0, pool.hedgeUnits(address(stocks[0])), "tracked");
    }

    function invariant_R7_noDanglingApprovals() public view {
        address[4] memory owners = [address(pool), address(vreg), address(up), address(down)];
        address[4] memory spenders = [address(pool), address(vreg), address(up), address(down)];
        for (uint256 i; i < 4; ++i) {
            for (uint256 j; j < 4; ++j) {
                assertEq(usdg.allowance(owners[i], spenders[j]), 0);
                assertEq(stocks[0].allowance(owners[i], spenders[j]), 0);
            }
        }
    }

    /// @dev The handler's actions really run (not only revert): one deterministic pass through each of them.
    function test_R7_handlerActionsSucceed() public {
        handler.assume(0, 5_000); // call slice
        handler.assume(2, 5_000); // put slice
        handler.move(2_000, true);
        handler.sell(0, 5_000);
        handler.time(1 days);
        handler.release(0, 10_000);
        handler.deposit(1, 1_000e6);
        handler.withdraw(0, 5_000);
        handler.roll(0);
        handler.roll(1);
        handler.claim(0);
        handler.buy(1, 1e18);
        assertEq(handler.ok("assume"), 2);
        assertEq(handler.ok("sell"), 1);
        assertEq(handler.ok("release"), 1);
        assertEq(handler.ok("roll"), 2);
        assertEq(handler.ok("buy"), 1);
        assertEq(handler.panics(), 0);
        invariant_R7_stockConservation();
        invariant_R7_lockedWithinCollateral();
        invariant_R7_coverageWithinSupply();
    }

    function invariant_R7_callSummary() public view {
        assertGt(handler.calls() + 1, 0);
        console2.log("ok buy/sell/assume/release/roll", handler.ok("buy"), handler.ok("sell"));
        console2.log("  ", handler.ok("assume"), handler.ok("release"), handler.ok("roll"));
    }
}
