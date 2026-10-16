// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {PriceReading} from "../libs/OptionTypes.sol";

interface IPriceGuard {
    event StockConfigured(address indexed stock, address feed, bool multiplierEmbedded, uint32 maxAgeRegular, uint32 maxAgeExtended);
    event BuysPausedSet(address indexed stock, bool paused, bytes32 reason);
    /// @dev Added by todo 04b (additive). pool == address(0) means no TWAP cross-check for that stock.
    event TwapSourceSet(address indexed stock, address pool, uint32 window, uint16 bandBps);

    error StockUnknown(address stock);
    error MultiplierContinuityFailed(address stock);

    struct StockConfig {
        address feed;
        bool multiplierEmbedded; // feed already returns price x uiMultiplier (default for Robinhood feeds, verified in chain-facts)
        uint32 maxAgeRegular;
        uint32 maxAgeExtended;
        uint16 continuityBps; // max allowed one-step jump after a multiplier change that is not a split
        bool enabled;
    }

    function setStock(address stock, StockConfig calldata cfg) external;
    function setBuysPaused(address stock, bool paused) external;

    /// @dev Reverts only for unknown stock. Never reverts on stale/paused feeds: reports fresh=false / session HALTED.
    function read(address stock) external view returns (PriceReading memory);
    function config(address stock) external view returns (StockConfig memory);
    function lastGoodPrice(address stock) external view returns (uint256 s, uint256 at);
    /// @dev Keeper records the last good price (called by accrual); used for CLOSED/HALTED sells.
    function poke(address stock) external returns (PriceReading memory);

    // ---- added by todo 04b (TWAP cross-check), additive only

    /// @dev Admin. Cross-check the feed against the `window`-second TWAP of the stock/USDG Uniswap v3 `pool`: in
    /// REGULAR/EXTENDED buys pause when |S/TWAP - 1| > bandBps, or when the TWAP cannot be read. Sells are unaffected.
    /// window 0 / bandBps 0 select the defaults; pool address(0) removes the check.
    function setTwapSource(address stock, address pool, uint32 window, uint16 bandBps) external;
    /// @return twap WAD USDG per whole Stock Token over the configured window (0 when unavailable or not configured)
    /// @return ok true when a live (REGULAR/EXTENDED, not halted) feed price exists and lies within the band of `twap`
    function twapCheck(address stock) external view returns (uint256 twap, bool ok);
}
