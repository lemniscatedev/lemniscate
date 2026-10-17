// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IFeeRouter} from "../interfaces/IFeeRouter.sol";
import {IReserve} from "../interfaces/IReserve.sol";
import {IVaultRegistry} from "../interfaces/IWriterVault.sol";
import {ILmnsStaking} from "../interfaces/ILmnsStaking.sol";

/// @title PoolLayers
/// @notice The Writer Pool's income split and loss layers: protocol fee and reserve funding on income, the writer
/// vaults' share of income (phase 2, todo 19) and the loss order Reserve -> staked $LMNS (phase 2, todo 20).
/// External library (delegatecalled, runs with the pool's balance) so the pool stays under the contract size limit
/// with both phase-2 modules merged. Deployments link it into WriterPool, like PoolHedging.
library PoolLayers {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;

    /// @dev Same signatures as the pool's events, so logs read the same whichever contract emits them.
    event IncomeSplit(uint256 incomeUsdg, uint256 protocolFeeUsdg, uint256 reserveUsdg, uint256 feeOwedUsdg);
    event ReserveDrawn(uint256 usdg);
    event StakeSlashed(uint256 requested, uint256 received);
    event VaultFundingPaid(bytes32 indexed seriesId, uint256 usdg);
    event VaultHookFailed(bytes32 indexed seriesId);

    /// @dev Pays the protocol fee (plus any fee owed) to the router and, for spread income, the reserve's share until
    /// it holds its target of NAV. Never sells hedges for fees: what cash cannot cover is owed. Returns the new feeOwed.
    function takeIncome(
        IERC20 usdg,
        IFeeRouter router,
        IReserve r,
        uint256 feeOwed,
        uint256 lastNavUsdg,
        uint256 income,
        bool isSpread
    ) external returns (uint256 owedAfter) {
        uint256 fee = address(router) == address(0) ? 0 : Math.mulDiv(income, router.protocolFeeBps(), BPS);
        uint256 owed = feeOwed + fee;
        uint256 cash = usdg.balanceOf(address(this));
        uint256 sent = owed < cash ? owed : cash;
        if (sent != 0) usdg.safeTransfer(address(router), sent);
        owedAfter = owed - sent;
        cash -= sent;

        uint256 toReserve;
        if (isSpread && address(r) != address(0) && income != 0) {
            uint256 target = Math.mulDiv(lastNavUsdg, r.targetBps(), BPS);
            uint256 held = usdg.balanceOf(address(r));
            toReserve = Math.mulDiv(income, r.incomeShareBps(), BPS);
            uint256 room = target > held ? target - held : 0;
            if (toReserve > room) toReserve = room;
            if (toReserve > cash) toReserve = cash;
            if (toReserve != 0) usdg.safeTransfer(address(r), toReserve);
        }
        if (income != 0 || sent != 0) emit IncomeSplit(income, sent, toReserve, owedAfter);
    }

    /// @dev Sends the vaults' net share of `income` on `id` (gross share less the protocol fee, which `takeIncome`
    /// already charged on the whole income) to the hook, as far as cash allows. A failing hook never blocks the caller.
    function payVaults(IERC20 usdg, address hook, IFeeRouter router, bytes32 id, uint256 income, uint256 supply)
        public
    {
        if (hook == address(0) || income == 0) return;
        try IVaultRegistry(hook).shareOf(id, income, supply) returns (uint256 gross) {
            uint256 net = address(router) == address(0) ? gross : gross - Math.mulDiv(gross, router.protocolFeeBps(), BPS);
            uint256 cash = usdg.balanceOf(address(this));
            if (net > cash) net = cash;
            if (net == 0 || !usdg.trySafeTransfer(hook, net)) return;
            try IVaultRegistry(hook).routeFunding(id, net) {
                emit VaultFundingPaid(id, net);
            } catch {
                emit VaultHookFailed(id);
            }
        } catch {
            emit VaultHookFailed(id);
        }
    }

    /// @dev Engine buyback (todo 19): the vaults' share of the spread, then the hook settles the covered slice. A
    /// failing hook never blocks the sale.
    function buyback(
        IERC20 usdg,
        address hook,
        IFeeRouter router,
        bytes32 id,
        uint256 tokens,
        uint256 supplyBefore,
        uint256 sWad,
        uint256 spreadUsdg
    ) external {
        if (hook == address(0)) return;
        payVaults(usdg, hook, router, id, spreadUsdg, supplyBefore);
        try IVaultRegistry(hook).onBuyback(id, tokens, supplyBefore, sWad) {}
        catch {
            emit VaultHookFailed(id);
        }
    }

    /// @dev Realises `amount` of the reserve share: the Reserve first, then a slash of the staked $LMNS for the rest.
    function drawReserve(IReserve reserve, ILmnsStaking staking, uint256 amount) external {
        if (amount == 0) return;
        uint256 sent;
        if (address(reserve) != address(0)) {
            sent = reserve.cover(amount);
            if (sent != 0) emit ReserveDrawn(sent);
        }
        if (sent < amount && address(staking) != address(0)) {
            uint256 got = staking.slash(amount - sent);
            if (got != 0) emit StakeSlashed(amount - sent, got);
        }
    }
}
