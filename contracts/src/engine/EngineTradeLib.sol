// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IOptionEngine} from "../interfaces/IOptionEngine.sol";
import {IOptionToken} from "../interfaces/IOptionToken.sol";
import {PriceReading, Series} from "../libs/OptionTypes.sol";
import {EngineHelper} from "../EngineHelper.sol";
import {EngineStorage} from "./EngineStorage.sol";
import {EngineCore} from "./EngineCore.sol";

/// @title EngineTradeLib
/// @notice Buy and shield of LemniscateEngine (external library, delegatecalled by the engine behind its reentrancy lock;
/// `msg.sender` is the trader). Sells and the queue live in EngineSellLib.
library EngineTradeLib {
    using SafeERC20 for IERC20;

    uint256 private constant WAD = 1e18;
    uint256 private constant BPS = 10_000;
    uint256 private constant SYNC_BATCH = 64;

    /// @dev Accrue, buy checks, caps and stress on the post-trade book, price, then USDG buyer -> pool and mint.
    function buy(EngineHelper h, bytes32 id, uint256 units, uint256 maxCost, uint64 deadline, address recipient)
        public
        returns (uint256 cost, uint256 tokens)
    {
        if (block.timestamp > deadline) revert IOptionEngine.Expired();
        if (units == 0 || recipient == address(0)) revert IOptionEngine.BelowMinimum();
        EngineStorage.Layout storage $ = EngineStorage.layout();
        // Review R02: a buy's hold is written to its recipient, so only the buyer itself (or the agent router, under
        // the owner's policy) may be the recipient: nobody can open, pin or extend another account's hold.
        if (recipient != msg.sender && msg.sender != $.agentRouter) revert IOptionEngine.NotOwnBuy();
        EngineCore.Ctx memory c = EngineCore.context(h, id, true);
        EngineCore.applyFunding(h, c);
        uint8 code = EngineCore.buyBlock(c);
        if (code != 0) h.revertBlock(code, id, c.session, c.stock);
        if (c.norm < EngineCore.BUY_MIN_NORM) revert IOptionEngine.SeriesNotBuyable(id);
        tokens = units * WAD / c.norm;
        if (tokens == 0) revert IOptionEngine.BelowMinimum();
        EngineHelper.Book memory b = EngineCore.bookFor(h, c, tokens, true, false);
        int256 navNow = $.pool.navFor(b.tNow);
        EngineCore.checkCaps(h, c, b, navNow, recipient, tokens);
        uint256 sTrade = EngineCore.tradeS(c, true);
        (IOptionEngine.Quote memory q, uint256 spread) =
            EngineCore.priceTrade(h, c, b, navNow, units, true, msg.sender, sTrade);
        cost = q.usdg;
        if (cost < EngineCore.minTradeUsdg()) revert IOptionEngine.BelowMinimum();
        if (cost > maxCost) revert IOptionEngine.Slippage(cost, maxCost);
        EngineCore.addHold(id, recipient, sTrade, block.timestamp + EngineCore.holdSeconds(), tokens, c.isCall);
        $.usdg.safeTransferFrom(msg.sender, address($.pool), cost);
        $.pool.onSale(id, cost, spread);
        IOptionToken(c.token).mint(recipient, tokens);
        EngineCore.markLive(id, c.stock);
        EngineCore.storeBook(c, b);
        emit IOptionEngine.Bought(id, msg.sender, recipient, units, tokens, cost, q.vMarkWad, q.sigmaBps, c.session);
    }

    /// @dev Weekly Down option with the largest buyable strike <= S x (1 - pct) for `tokenUnits` held Stock Token
    /// units (1e18 raw units = one whole token = 1e18 option units).
    function shield(EngineHelper h, address stock, uint256 tokenUnits, uint16 pctBps, uint256 maxCost, uint64 deadline)
        external
        returns (bytes32 id, uint256 cost)
    {
        if (tokenUnits == 0 || pctBps >= BPS) revert IOptionEngine.BelowMinimum();
        uint256 held = IERC20(stock).balanceOf(msg.sender);
        if (held < tokenUnits) revert IOptionEngine.ShieldExceedsHolding(held, tokenUnits);
        EngineCore.sync(SYNC_BATCH);
        PriceReading memory r = EngineCore.readPrice(stock, true);
        if (r.s == 0) revert IOptionEngine.StalePrice();
        id = pickShield(stock, Math.mulDiv(r.s, BPS - pctBps, BPS));
        (cost,) = buy(h, id, tokenUnits, maxCost, deadline, msg.sender);
        emit IOptionEngine.ShieldBought(msg.sender, stock, id, tokenUnits, cost);
    }

    /// @dev Largest buyable WEEKLY Down strike <= target. Candidates are filtered on the engine's own strike copy (one
    /// SLOAD per entry); an archived candidate is removed from the list (swap and pop), and `pruneShieldList` lets
    /// anyone remove the rest, so the list tracks the strikes that can still be bought, not every series ever listed.
    function pickShield(address stock, uint256 target) private returns (bytes32 best) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        bytes32[] storage ids = $.weeklyPuts[stock];
        uint256 bestK;
        uint256 i;
        while (i < ids.length) {
            bytes32 id = ids[i];
            uint256 k = $.info[id].strike;
            if (k > target || k <= bestK) {
                ++i;
                continue;
            }
            Series memory s = $.registry.seriesOf(id);
            if (s.archived) {
                ids[i] = ids[ids.length - 1];
                ids.pop();
                continue;
            }
            ++i;
            if (!s.buyable) continue;
            best = id;
            bestK = k;
        }
        if (best == bytes32(0)) revert IOptionEngine.SeriesNotBuyable(bytes32(0));
    }
}
