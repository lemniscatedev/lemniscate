// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SystemFixture} from "../system/SystemFixture.sol";
import {VaultRegistry} from "../../src/vaults/VaultRegistry.sol";
import {WriterVault} from "../../src/vaults/WriterVault.sol";
import {CoveredUpVault} from "../../src/vaults/CoveredUpVault.sol";
import {CashDownVault} from "../../src/vaults/CashDownVault.sol";
import {IVaultRegistry} from "../../src/interfaces/IWriterVault.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {ISeriesRegistry} from "../../src/interfaces/ISeriesRegistry.sol";

/// @notice The real option system (SystemFixture: engine, pool, reserve, fee router, registry, PriceGuard, VolOracle)
/// plus a VaultRegistry wired as the pool's vault hook and one CoveredUpVault (calls, 100%-150% moneyness) and one
/// CashDownVault (puts, 50%-100%) on stock 0 at the Weekly speed. Vaults are closed until a test opens them.
abstract contract VaultFixture is SystemFixture {
    uint256 internal constant EPOCH = 7 days;
    address internal guardian = makeAddr("guardian");
    address internal bob = makeAddr("bob");
    address internal carol = makeAddr("carol");

    VaultRegistry internal vreg;
    CoveredUpVault internal up;
    CashDownVault internal down;

    function _deployVaults() internal {
        _deploySystem(1, 10_000_000e6);
        vreg = new VaultRegistry(
            admin, address(pool), ISeriesRegistry(address(registry)), IPriceGuard(address(guard)), IERC20(address(usdg))
        );
        up = new CoveredUpVault(_params(true));
        down = new CashDownVault(_params(false));
        vm.startPrank(admin);
        vreg.addVault(address(up));
        vreg.addVault(address(down));
        vreg.grantRole(vreg.ALLOCATOR_ROLE(), keeper);
        pool.setVaultHook(address(vreg));
        up.grantRole(up.GUARDIAN_ROLE(), guardian);
        down.grantRole(down.GUARDIAN_ROLE(), guardian);
        vm.stopPrank();
    }

    function _params(bool isCall) internal view returns (WriterVault.Params memory p) {
        p = WriterVault.Params({
            admin: admin,
            asset: isCall ? IERC20(address(stocks[0])) : IERC20(address(usdg)),
            usdg: IERC20(address(usdg)),
            stock: address(stocks[0]),
            tauSeconds: WEEKLY,
            minMoneynessBps: isCall ? 10_000 : 5_000,
            maxMoneynessBps: isCall ? 15_000 : 10_000,
            registry: IVaultRegistry(address(vreg)),
            priceGuard: IPriceGuard(address(guard)),
            epoch: EPOCH,
            minDeposit: isCall ? 1e15 : 1e6,
            name: isCall ? "Covered Up" : "Cash Down",
            symbol: isCall ? "cUP" : "cDN"
        });
    }

    function _open() internal {
        vm.startPrank(admin);
        up.setOpen(true);
        down.setOpen(true);
        vm.stopPrank();
    }

    /// @dev `who` deposits `amount` of the vault's collateral (minted to them first).
    function _vdeposit(WriterVault v, address who, uint256 amount) internal {
        if (v.isCallVault()) stocks[0].mint(who, amount);
        else usdg.mint(who, amount);
        vm.startPrank(who);
        IERC20(v.asset()).approve(address(v), amount);
        v.deposit(amount);
        vm.stopPrank();
    }

    /// @dev Ends the epoch: warps to its end, keeps price and vol fresh, accrues, rolls.
    function _roll(WriterVault v) internal {
        uint256 endsAt = v.epochEndsAt();
        if (vm.getBlockTimestamp() < endsAt) vm.warp(endsAt);
        _fresh();
        v.roll();
    }

    /// @dev Fresh feed round at the current price, fresh vol posts, every live series accrued.
    function _fresh() internal {
        _setPrice(0, px[0]);
        _refreshVols();
        _accrueAll();
    }

    function _assume(WriterVault v, bytes32 id, uint256 tokens) internal {
        vm.prank(keeper);
        vreg.assume(address(v), id, tokens);
    }

    function _claim(WriterVault v, address who) internal returns (uint256 shares, uint256 coll, uint256 u) {
        vm.prank(who);
        return v.claim();
    }

    function _units(bytes32 id, uint256 tokens) internal view returns (uint256) {
        return tokens * registry.seriesOf(id).norm / WAD;
    }
}
