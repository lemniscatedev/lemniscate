// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {PriceReading, Speed, VolReading} from "../libs/OptionTypes.sol";
import {EngineHelper} from "../EngineHelper.sol";
import {EngineStorage} from "./EngineStorage.sol";
import {EngineCore} from "./EngineCore.sol";

/// @title EngineViewLib
/// @notice The monitoring views of LemniscateEngine (exact liability, stress loss). External library, delegatecalled;
/// split out of EngineOpsLib when the phase-2 modules were merged so every library keeps >= 1 KB of EIP-170 margin.
library EngineViewLib {
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
