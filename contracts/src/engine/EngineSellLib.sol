// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {SafeCast} from "@openzeppelin/contracts/utils/math/SafeCast.sol";
import {IOptionEngine} from "../interfaces/IOptionEngine.sol";
import {IOptionToken} from "../interfaces/IOptionToken.sol";
import {EngineHelper} from "../EngineHelper.sol";
import {EngineStorage} from "./EngineStorage.sol";
import {EngineCore} from "./EngineCore.sol";

/// @title EngineSellLib
/// @notice Sell, the escrow of queued sells, their fill and cancel (external library, delegatecalled by the engine behind
/// its reentrancy lock; `msg.sender` is the seller or the filler). Split out of EngineTradeLib / EngineOpsLib for the
/// review fixes (todo 27) so every library keeps >= 1 KB of EIP-170 margin.
/// Sells and fills are priced at EngineCore.tradeS: the worse for the seller of the feed (or last good / settlement)
/// S and the trade TWAP, and inside the seller's hold also the buy-time S (review F01/F02/F10/F21/F22/F23).
library EngineSellLib {
    using SafeCast for uint256;

    uint256 private constant WAD = 1e18;

    /// @dev Never blocked by a pause. HALTED (or no usable price/vol) escrows into a ticket; so does a payout the pool
    /// cannot make (USDG or Stock Token paused or frozen by its issuer), instead of reverting or losing value.
    function sell(EngineHelper h, bytes32 id, uint256 tokens, uint256 minProceeds, uint64 deadline, address recipient)
        public
        returns (uint256 proceeds)
    {
        if (block.timestamp > deadline) revert IOptionEngine.Expired();
        if (tokens == 0 || recipient == address(0)) revert IOptionEngine.BelowMinimum();
        EngineStorage.Layout storage $ = EngineStorage.layout();
        EngineCore.Ctx memory c = EngineCore.context(h, id, false);
        EngineCore.applyFunding(h, c);
        EngineCore.checkSellSize(c, msg.sender, tokens);
        if (!EngineCore.sellable(c)) {
            escrow(c, msg.sender, recipient, tokens, minProceeds);
            return 0;
        }
        uint256 units = Math.mulDiv(tokens, c.norm, WAD);
        EngineHelper.Book memory b = EngineCore.bookFor(h, c, tokens, false, false);
        (IOptionEngine.Quote memory q, uint256 spread) = EngineCore.priceTrade(
            h, c, b, $.pool.navFor(b.tNow), units, false, msg.sender, EngineCore.tradeS(c, false, msg.sender)
        );
        proceeds = q.usdg;
        if (proceeds < minProceeds) revert IOptionEngine.Slippage(proceeds, minProceeds);
        uint256 gasBefore = gasleft();
        try $.pool.pay(recipient, proceeds, spread) {
            IOptionToken(c.token).burn(msg.sender, tokens);
            EngineCore.dropIfEmpty(id, c.stock, c.token);
            EngineCore.storeBook(c, b);
            EngineCore.reportBuyback(c, tokens, spread);
            emit IOptionEngine.Sold(id, msg.sender, recipient, units, tokens, proceeds, q.vMarkWad, q.sigmaBps, c.session);
            EngineCore.recheck(h, false);
        } catch {
            // A payout that failed for lack of gas is not a blocked payout: never queue the sell for that.
            EngineCore.requireNotOutOfGas(gasBefore);
            escrow(c, msg.sender, recipient, tokens, minProceeds);
            proceeds = 0;
        }
    }

    /// @dev Anyone may fill at the current trade price (any session but HALTED), never below the seller's minProceeds.
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
        (IOptionEngine.Quote memory q, uint256 spread) = EngineCore.priceTrade(
            h, c, b, $.pool.navFor(b.tNow), units, false, t.seller, EngineCore.tradeS(c, false, t.seller)
        );
        usdgOut = q.usdg;
        if (usdgOut < t.minProceeds) revert IOptionEngine.Slippage(usdgOut, t.minProceeds);
        t.open = false;
        $.pool.pay(t.recipient, usdgOut, spread); // a blocked payout reverts: the ticket stays open
        IOptionToken(c.token).burn(address(this), tokens);
        EngineCore.dropIfEmpty(t.id, c.stock, c.token);
        EngineCore.storeBook(c, b);
        EngineCore.reportBuyback(c, tokens, spread);
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

    /// @dev Moves `tokens` of `seller` into the engine's escrow (they keep paying funding) and opens a ticket.
    function escrow(EngineCore.Ctx memory c, address seller, address recipient, uint256 tokens, uint256 minProceeds)
        private
    {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        IOptionToken(c.token).burn(seller, tokens);
        IOptionToken(c.token).mint(address(this), tokens);
        uint256 ticket = ++$.ticketCount;
        $.tickets[ticket] = EngineStorage.Ticket({
            seller: seller,
            queuedAt: uint64(block.timestamp),
            open: true,
            recipient: recipient,
            id: c.id,
            tokens: tokens.toUint128(),
            minProceeds: minProceeds.toUint128()
        });
        emit IOptionEngine.SellQueued(ticket, c.id, seller, recipient, tokens.toUint128(), uint64(block.timestamp));
    }
}
