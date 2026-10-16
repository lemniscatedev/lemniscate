// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ILemniscateEngine} from "./ILemniscateEngine.sol";
import {AccountView, MarketView, VaultView} from "../libs/LemniscateTypes.sol";

interface ILemniscateLens {
    function markets(ILemniscateEngine engine) external view returns (MarketView[] memory);

    function vault(ILemniscateEngine engine) external view returns (VaultView memory);

    function account(ILemniscateEngine engine, address user) external view returns (AccountView memory);
}
