// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IPriceReference} from "../../src/interfaces/IPriceReference.sol";

contract MockPriceReference is IPriceReference {
    uint256 public price;
    bool public reverts;
    /// @dev Spot price for `spotPrice`; 0 = same as `price`.
    uint256 public spot;

    function setSpot(uint256 spot_) external {
        spot = spot_;
    }

    function spotPrice(address, uint24) external view returns (uint256) {
        require(!reverts, "reference down");
        return spot == 0 ? price : spot;
    }

    function setPrice(uint256 price_) external {
        price = price_;
    }

    function setReverts(bool reverts_) external {
        reverts = reverts_;
    }

    function referencePrice(address, uint24) external view returns (uint256) {
        require(!reverts, "reference down");
        return price;
    }
}
