// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IOptionToken} from "../interfaces/IOptionToken.sol";
import {IOptionEngine} from "../interfaces/IOptionEngine.sol";
import {PriceReading, SessionKind, Speed, VolReading} from "../libs/OptionTypes.sol";
import {EngineHelper} from "../EngineHelper.sol";
import {EngineStorage} from "./EngineStorage.sol";
import {EngineCore} from "./EngineCore.sol";

/// @title EngineOpsLib
/// @notice Accrual, the queued-sell fill and cancel, risk pokes and the valuation views of LemniscateEngine (external library, delegatecalled).
library EngineOpsLib {
    uint256 private constant WAD = 1e18;

    /// @dev A one-SLOAD no-op once the series is accrued in this block (the option token calls it on every transfer).
    function accrue(EngineHelper h, bytes32 id) external {
        EngineStorage.SeriesInfo storage si = EngineStorage.layout().info[id];
        if (si.known && si.lastAccrual >= block.timestamp) return;
        EngineCore.Ctx memory c = EngineCore.context(h, id, false);
        if (EngineCore.applyFunding(h, c)) EngineCore.recheck(h, false);
    }

    /// @dev Skips, for about one cold SLOAD each, series already accrued in this block and known series with no
    /// supply (their norm cannot move and their book is zero), so archived or empty series cost nothing (R2).
    function accrueMany(EngineHelper h, bytes32[] calldata ids) external {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        for (uint256 i; i < ids.length; ++i) {
            EngineStorage.SeriesInfo storage si = $.info[ids[i]];
            // one slot: no tokens outstanding (unknown series included) or already accrued in this block
            if (si.liveIdx == 0 || si.lastAccrual >= block.timestamp) continue;
            EngineCore.Ctx memory c = EngineCore.context(h, ids[i], false);
            EngineCore.applyFunding(h, c);
        }
        EngineCore.recheck(h, true);
    }

    function fillQueued(EngineHelper h, uint256 ticket) external returns (uint256 usdgOut) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        EngineStorage.Ticket storage t = $.tickets[ticket];
        if (!t.open) revert IOptionEngine.QueueNotFillable(ticket);
        EngineCore.Ctx memory c = EngineCore.context(h, t.id, false);
        EngineCore.applyFunding(h, c);
        if (!EngineCore.sellable(c)) revert IOptionEngine.QueueNotFillable(ticket);
        uint256 tokens = t.tokens;
        uint256 units = Math.mulDiv(tokens, c.norm, WAD);
        EngineHelper.Book memory b = EngineCore.bookFor(h, c, tokens, false, false);
        (IOptionEngine.Quote memory q, uint256 spread) =
            EngineCore.priceTrade(h, c, b, $.pool.navFor(b.tNow), units, false);
        usdgOut = q.usdg;
        t.open = false;
        $.pool.pay(t.recipient, usdgOut, spread); // a blocked payout reverts: the ticket stays open
        IOptionToken(c.token).burn(address(this), tokens);
        EngineCore.dropIfEmpty(t.id, c.stock, c.token);
        EngineCore.storeBook(c, b);
        emit IOptionEngine.Sold(t.id, t.seller, t.recipient, units, tokens, usdgOut, q.vMarkWad, q.sigmaBps, c.session);
        emit IOptionEngine.QueuedSellFilled(ticket, msg.sender, usdgOut);
        EngineCore.recheck(h, false);
    }

    function cancelQueued(uint256 ticket) external {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        EngineStorage.Ticket storage t = $.tickets[ticket];
        if (!t.open) revert IOptionEngine.QueueNotFillable(ticket);
        if (msg.sender != t.seller) revert IOptionEngine.NotTicketSeller(ticket);
        t.open = false;
        address token = $.info[t.id].token;
        IOptionToken(token).burn(address(this), t.tokens);
        IOptionToken(token).mint(t.seller, t.tokens);
        emit IOptionEngine.QueuedSellCancelled(ticket);
    }

    function pokeRisk(EngineHelper h) external {
        EngineCore.recheck(h, true);
    }

    /// @dev Removes up to `maxCount` archived series from `stock`'s shield list, scanning from the end.
    function pruneShieldList(address stock, uint256 maxCount) external returns (uint256 removed) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        bytes32[] storage ids = $.weeklyPuts[stock];
        uint256 i = ids.length;
        while (i > 0 && removed < maxCount) {
            --i;
            if (!$.registry.seriesOf(ids[i]).archived) continue;
            ids[i] = ids[ids.length - 1];
            ids.pop();
            ++removed;
        }
    }

    function syncSeries(uint256 maxCount) external {
        EngineCore.sync(maxCount);
    }

    /// @dev Exactly what a trade of `units` would get now (the trade's own accrual is simulated).
    function quote(EngineHelper h, bytes32 id, uint256 units, bool isBuy)
        external
        view
        returns (IOptionEngine.Quote memory q)
    {
        EngineCore.Ctx memory c = EngineCore.contextView(h, id, isBuy);
        if (!c.priced) {
            q.session = c.session;
            return q;
        }
        bool due = c.lastAccrual < block.timestamp;
        if (due) c.norm = EngineCore.nextNorm(c);
        uint256 tokens = isBuy ? units * WAD / c.norm : Math.mulDiv(units, WAD, c.norm, Math.Rounding.Ceil);
        EngineHelper.Book memory b = EngineCore.bookFor(h, c, tokens, isBuy, due);
        (q,) = EngineCore.priceTrade(h, c, b, EngineStorage.layout().pool.navFor(b.tNow), units, isBuy);
        q.buyable = EngineCore.buyBlock(c) == 0;
    }

    function vMark(EngineHelper h, bytes32 id)
        external
        view
        returns (uint256 vWad, uint256 payoffWad, uint64 sigmaBps, SessionKind session)
    {
        EngineCore.Ctx memory c = EngineCore.contextView(h, id, false);
        return (c.pu.v, c.pu.payoff, c.sigma, c.session);
    }

    /// @dev Exact recomputation at current prices (monitoring and tests; user paths use `bookValue`): one readLite
    /// and two vol reads per stock, live series only. A series whose stock has no usable price or vol right now is
    /// carried at its last-touch value.
    function totalLiability(EngineHelper h) external view returns (uint256 liabilityWad) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        for (uint256 i; i < $.stocks.length; ++i) {
            address stock = $.stocks[i];
            bytes32[] storage ids = $.live[stock];
            if (ids.length == 0) continue;
            PriceReading memory r = $.priceGuard.readLite(stock);
            VolReading memory vd = $.volOracle.read(stock, Speed.DAILY);
            VolReading memory vw = $.volOracle.read(stock, Speed.WEEKLY);
            for (uint256 j; j < ids.length; ++j) {
                EngineStorage.SeriesInfo memory si = $.info[ids[j]];
                uint256 supply = IERC20(si.token).totalSupply();
                VolReading memory vr = si.tau == EngineCore.TAU_DAILY ? vd : vw;
                if (EngineCore.inDomain(r.s) && vr.sigmaBps != 0) {
                    (uint256 v,) = h.valueAt(si.isCall, r.s, si.strike, vr.sigmaBps, vr.skewK, 0, si.tau);
                    liabilityWad += EngineCore.liab(supply, si.norm, v);
                } else {
                    liabilityWad += $.risk[ids[j]].value;
                }
            }
        }
    }

    function stressLoss(EngineHelper h) external view returns (uint256 lossWad, int256 navWad) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        EngineHelper.Risk memory none;
        return (EngineCore.stress(h, address(0), none, 0), $.pool.navFor($.bookValue));
    }
}
