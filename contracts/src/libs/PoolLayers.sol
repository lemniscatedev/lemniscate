// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IFeeRouter} from "../interfaces/IFeeRouter.sol";
import {IReserve} from "../interfaces/IReserve.sol";
import {IVaultRegistry} from "../interfaces/IWriterVault.sol";
import {ILmnsStaking} from "../interfaces/ILmnsStaking.sol";
import {PoolHedging} from "./PoolHedging.sol";

/// @title PoolLayers
/// @notice The Writer Pool's income split and loss layers: protocol fee and reserve funding on income, the writer
/// vaults' share of income (phase 2, todo 19) and the loss order Reserve -> staked $LMNS (phase 2, todo 20).
/// External library (delegatecalled, runs with the pool's balance) so the pool stays under the contract size limit
/// with both phase-2 modules merged. Deployments link it into WriterPool, like PoolHedging.
library PoolLayers {
    using SafeERC20 for IERC20;

    uint256 private constant BPS = 10_000;

    /// @dev A withdrawal ticket (pool storage). `partialDay` = UTC day of its last partial (pro-rata) payment (F16).
    struct Ticket {
        address owner;
        uint64 claimableAt;
        uint32 partialDay;
        uint256 shares;
    }

    /// @dev F16: the day's pro-rata pot. The first partial claim of a UTC day records what can be paid and the queue
    /// then; every partial claim that day takes its part of that same pot, so claim order and repeated calls do not
    /// change what a ticket gets.
    struct Pot {
        uint32 day;
        uint112 usdg;
        uint112 queued;
    }

    /// @dev Pool inputs of a claim, from one valuation at the NAV guard's low edge.
    struct ClaimIn {
        uint256 value; // the ticket's value, USDG
        uint256 liquid; // cash + reserve share + hedges at their slippage floor, USDG
        uint256 queuedValue; // value of every queued share, USDG
        uint256 queued; // queued shares
        uint256 reserveShareUsdg;
        uint256 reserveBalUsdg; // USDG the Reserve holds
        uint256 supply;
    }

    error NotClaimable(uint64 claimableAt);
    error NothingClaimable();
    /// @dev F18: only the ticket owner may take a claim that is charged for an unrealised reserve or stake draw.
    error ClaimNeedsOwner(address owner);

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
    /// Returns the USDG actually received.
    function drawReserve(IReserve reserve, ILmnsStaking staking, uint256 amount) external returns (uint256 sent) {
        if (amount == 0) return 0;
        sent = _cover(reserve, amount);
        if (sent < amount) sent += _slash(staking, amount - sent);
    }

    function _cover(IReserve reserve, uint256 amount) private returns (uint256 sent) {
        if (amount == 0 || address(reserve) == address(0)) return 0;
        sent = reserve.cover(amount);
        if (sent != 0) emit ReserveDrawn(sent);
    }

    function _slash(ILmnsStaking staking, uint256 amount) private returns (uint256 got) {
        if (amount == 0 || address(staking) == address(0)) return 0;
        got = staking.slash(amount);
        if (got != 0) emit StakeSlashed(amount, got);
    }

    /// @dev The money part of `WriterPool.claim` (kept here so the pool stays under the size limit). Returns the USDG to
    /// pay the ticket owner and the shares to burn, and lowers the ticket's shares; the pool burns, pays and updates
    /// `queuedShares`.
    /// Full path: liquid assets cover every queued share and the hedge sales this claim needs clear; the whole ticket is
    /// paid and a forced sale's execution shortfall is charged to it.
    /// Pro-rata path (F16), when liquid assets cannot cover the queue or a needed sale fails: the first such claim of a
    /// UTC day raises cash for the whole queue once and records the day's pot (cash that then exists plus the queue's
    /// part of the reserve share) and the queued shares; every ticket that day is paid its part of that same pot, at
    /// most once a day. A loop of claim() calls, the claim order or split tickets therefore change nothing, and
    /// execution shortfall is shared by the queue.
    function settleClaim(
        Ticket storage t,
        Pot storage pot,
        PoolHedging.Book storage b,
        PoolHedging.Ctx memory c,
        IReserve reserve,
        ILmnsStaking staking,
        ClaimIn memory x
    ) external returns (uint256 paid, uint256 burnShares) {
        uint256 shares = t.shares;
        uint256 target = x.value;
        uint256 shortfall;
        bool proRata = x.liquid < x.queuedValue;
        if (!proRata) {
            uint256 slice = _reserveSlice(x, shares);
            // Audit L-1: when only the Reserve keeps NAV positive the slice can exceed the target; never underflow.
            uint256 need = target > slice ? target - slice : 0;
            if (c.usdg.balanceOf(address(this)) < need) shortfall = PoolHedging.ensureCash(b, c, need, false);
            proRata = c.usdg.balanceOf(address(this)) + shortfall < need;
        }
        if (proRata) {
            uint32 day = uint32(block.timestamp / 1 days);
            Pot memory p = pot;
            if (p.day != day) {
                uint256 reserveQueue = _reserveSlice(x, x.queued);
                uint256 want = x.queuedValue > reserveQueue ? x.queuedValue - reserveQueue : 0;
                if (c.usdg.balanceOf(address(this)) < want) PoolHedging.ensureCash(b, c, want, true);
                p = Pot(day, uint112(c.usdg.balanceOf(address(this)) + reserveQueue), uint112(x.queued));
                pot.day = p.day;
                pot.usdg = p.usdg;
                pot.queued = p.queued;
            }
            if (t.partialDay == day) revert NotClaimable(uint64((uint256(day) + 1) * 1 days));
            t.partialDay = day;
            target = Math.mulDiv(p.usdg, shares, p.queued);
            if (target > x.value) target = x.value;
            shortfall = 0; // shared by the queue: the pot is cash that exists
        }
        burnShares = target == x.value ? shares : Math.mulDiv(shares, target, x.value, Math.Rounding.Ceil);
        if (burnShares > shares) burnShares = shares;
        // Realise this claim's part of the reserve share (NAV-neutral for everyone else). F18: what the Reserve and the
        // stake slash do not deliver (a slash that cannot clear its floor returns 0) is charged to this claim, not to
        // the LPs who stay; only the owner may accept such a charged claim, so a stranger cannot force it on them.
        // The slice comes from each layer pro rata to what it covers (Reserve part, then stake part), so an exiting LP
        // never takes the staying LPs' part of the Reserve and leaves them only the stake.
        uint256 want = _reserveSlice(x, burnShares);
        uint256 fromReserve = Math.mulDiv(
            x.reserveShareUsdg < x.reserveBalUsdg ? x.reserveShareUsdg : x.reserveBalUsdg, burnShares, x.supply
        );
        uint256 got = _cover(reserve, fromReserve);
        got += _slash(staking, want - got);
        if (got < want) {
            if (msg.sender != t.owner) revert ClaimNeedsOwner(t.owner);
            shortfall += want - got;
        }
        uint256 cash = c.usdg.balanceOf(address(this));
        if (proRata && cash + shortfall < target) {
            // Never more than is there (the day's pot is a number; pay() and rebalance may have spent its cash). Review
            // R08: the shares burned shrink with the payout, so a capped claim keeps the shares it is not paid for.
            target = cash + shortfall;
            uint256 cut = Math.mulDiv(shares, target, x.value, Math.Rounding.Ceil);
            if (cut < burnShares) burnShares = cut;
        }
        paid = target > shortfall ? target - shortfall : 0;
        if (burnShares == 0 || paid == 0) revert NothingClaimable();
        t.shares = shares - burnShares;
    }

    function _reserveSlice(ClaimIn memory x, uint256 shares) private pure returns (uint256) {
        return Math.mulDiv(x.reserveShareUsdg, shares, x.supply);
    }
}
