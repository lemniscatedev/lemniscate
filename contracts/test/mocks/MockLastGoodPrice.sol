// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {PriceReading, SessionKind} from "../../src/libs/OptionTypes.sol";

/// @dev PriceGuard stand-in for SeriesRegistry tests: settable last good price and current reading.
contract MockLastGoodPrice is IPriceGuard {
    mapping(address => uint256) public last;
    mapping(address => uint256) public current;
    mapping(address => bool) public freshOf;

    function setLast(address stock, uint256 s) external {
        last[stock] = s;
    }

    function setCurrent(address stock, uint256 s, bool fresh) external {
        current[stock] = s;
        freshOf[stock] = fresh;
    }

    function setStock(address, StockConfig calldata) external pure {}
    function setBuysPaused(address, bool) external pure {}

    function read(address stock) public view returns (PriceReading memory r) {
        r.s = current[stock];
        r.session = SessionKind.REGULAR;
        r.fresh = freshOf[stock];
        r.updatedAt = block.timestamp;
    }

    function config(address) external pure returns (StockConfig memory c) {
        return c;
    }

    function lastGoodPrice(address stock) external view returns (uint256 s, uint256 at) {
        return (last[stock], block.timestamp);
    }

    function poke(address stock) external view returns (PriceReading memory) {
        return read(stock);
    }

    function setTwapSource(address, address, uint32, uint16) external pure {}

    function twapCheck(address) external pure returns (uint256 twap, bool ok) {
        return (0, true);
    }
}
