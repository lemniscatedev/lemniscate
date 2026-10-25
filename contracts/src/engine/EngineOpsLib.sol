// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IOptionEngine} from "../interfaces/IOptionEngine.sol";
import {SessionKind} from "../libs/OptionTypes.sol";
import {EngineHelper} from "../EngineHelper.sol";
import {EngineStorage} from "./EngineStorage.sol";
import {EngineCore} from "./EngineCore.sol";

/// @title EngineOpsLib
/// @notice Accrual, dust retirement, the ORC-4 settlement, risk pokes, quote and vMark of LemniscateEngine (external
/// library, delegatecalled).
library EngineOpsLib {
    uint256 private constant WAD = 1e18;

    event SeriesRetired(bytes32 indexed id);
    event StockSettled(address indexed stock, uint256 s);

    error NotSettleable(address stock);

    /// @dev A one-SLOAD no-op once the series is accrued in this block (the option token calls it on every transfer).
    function accrue(EngineHelper h, bytes32 id) external {
        EngineStorage.SeriesInfo storage si = EngineStorage.layout().info[id];
        if (si.known && si.lastAccrual >= block.timestamp) return;
        EngineCore.Ctx memory c = EngineCore.context(h, id, false);
        if (EngineCore.applyFunding(h, c)) EngineCore.recheck(h, false);
    }

    /// @dev Skips, for about one cold SLOAD each, series already accrued in this block and series without units (no
    /// supply; unknown series included). Review R09: dust series are accrued when sent (the keeper sends them at its
    /// slower dust cadence, decision 49): a NAV-mark pass needs every series with units re-marked, in any batching.
    /// Review R07: retired series too, so the keeper's dust pass really re-marks them (and re-lists them once they are
    /// worth the minimum again).
    function accrueMany(EngineHelper h, bytes32[] calldata ids) external {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        for (uint256 i; i < ids.length; ++i) {
            EngineStorage.SeriesInfo storage si = $.info[ids[i]];
            // one slot: no tokens outstanding (unknown series included; retired dust series still count) or already
            // accrued in this block
            if (si.liveIdx == 0 || si.lastAccrual >= block.timestamp) continue;
            EngineCore.Ctx memory c = EngineCore.context(h, ids[i], false);
            EngineCore.applyFunding(h, c);
        }
        EngineCore.recheck(h, true);
    }

    /// @dev Review F08/F24: takes series whose whole outstanding value (refreshed now) is under the minimum trade off
    /// the live list, so the keeper's 5-minute grid never grows with dust. Holders keep their tokens and can still sell
    /// or transfer them. Review R07: a retired series still accrues when sent to accrueMany (the keeper's dust pass),
    /// keeps its units in the NAV bounds (dust tier) and the exact liability, and any accrual that finds it worth the
    /// minimum again puts it back on the live list.
    function retireDust(EngineHelper h, bytes32[] calldata ids) external returns (uint256 retired) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        uint256 dust = EngineCore.minTradeUsdg() * 1e12;
        for (uint256 i; i < ids.length; ++i) {
            EngineStorage.SeriesInfo storage si = $.info[ids[i]];
            if (si.liveIdx == 0 || si.liveIdx == EngineCore.RETIRED) continue;
            EngineCore.Ctx memory c = EngineCore.context(h, ids[i], false);
            EngineCore.applyFunding(h, c);
            if ($.risk[ids[i]].value >= dust) continue;
            EngineCore.dropFromLive(ids[i], c.stock);
            si.liveIdx = EngineCore.RETIRED;
            if (!$.everRetired[ids[i]]) {
                $.everRetired[ids[i]] = true;
                $.retired[c.stock].push(ids[i]);
            }
            emit SeriesRetired(ids[i]);
            ++retired;
        }
    }

    /// @dev ORC-4 (review F07/F21): once a stock's feed has been HALTED for the settle delay (PriceGuard.haltedSince,
    /// recorded by `poke`), anyone may settle it at its last good price. Its sells and queued fills then price as
    /// CLOSED at that S (worse-of the trade TWAP, CLOSED spread) instead of waiting forever; buys stay off. A live
    /// reading ends the settlement.
    function settleHalted(address stock) external returns (uint256 s) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        (bool ok, bytes memory data) =
            address($.priceGuard).staticcall(abi.encodeWithSignature("haltedSince(address)", stock));
        uint256 since = ok && data.length >= 32 ? abi.decode(data, (uint256)) : 0;
        uint32 delay = $.guards.haltSettleDelay;
        if (since == 0 || block.timestamp < since + (delay == 0 ? EngineCore.DEFAULT_SETTLE_DELAY : delay)) {
            revert NotSettleable(stock);
        }
        if ($.priceGuard.readLite(stock).session != SessionKind.HALTED) revert NotSettleable(stock);
        (s,) = $.priceGuard.lastGoodPrice(stock);
        if (s == 0 || !EngineCore.inDomain(s)) revert NotSettleable(stock);
        $.settleS[stock] = s;
        emit StockSettled(stock, s);
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

    /// @dev Exactly what a buy of `units` would get now (the trade's own accrual is simulated); sells are quoted by
    /// EngineSellLib.quoteSell (the seller's hold). `account` gets its $LMNS fee tier (zero = no discount).
    function quote(EngineHelper h, bytes32 id, uint256 units, bool isBuy, address account)
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
        (q,) = EngineCore.priceTrade(
            h, c, b, EngineStorage.layout().pool.navFor(b.tNow), units, isBuy, account, EngineCore.tradeS(c, isBuy)
        );
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
}
