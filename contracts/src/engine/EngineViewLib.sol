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
    /// and two vol reads per stock, live series and (review R07) series retired as dust that still have supply. A
    /// series whose stock has no usable price or vol right now is carried at its last-touch value.
    function totalLiability(EngineHelper h) external view returns (uint256 liabilityWad) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        for (uint256 i; i < $.stocks.length; ++i) {
            address stock = $.stocks[i];
            bytes32[] storage live = $.live[stock];
            bytes32[] storage gone = $.retired[stock];
            if (live.length == 0 && gone.length == 0) continue;
            PriceReading memory r = $.priceGuard.readLite(stock);
            VolReading[2] memory v = [$.volOracle.read(stock, Speed.DAILY), $.volOracle.read(stock, Speed.WEEKLY)];
            for (uint256 j; j < live.length; ++j) {
                liabilityWad += _liab(h, live[j], r.s, v);
            }
            for (uint256 j; j < gone.length; ++j) {
                if ($.info[gone[j]].liveIdx == EngineCore.RETIRED) liabilityWad += _liab(h, gone[j], r.s, v); // re-listed: counted above
            }
        }
    }

    function _liab(EngineHelper h, bytes32 id, uint256 s, VolReading[2] memory v) private view returns (uint256) {
        EngineStorage.SeriesInfo storage si = EngineStorage.layout().info[id];
        uint256 supply = IERC20(si.token).totalSupply();
        if (supply == 0) return 0;
        VolReading memory vr = si.tau == EngineCore.TAU_DAILY ? v[0] : v[1];
        if (!EngineCore.inDomain(s) || vr.sigmaBps == 0) return EngineStorage.layout().risk[id].value;
        (uint256 val,) = h.valueAt(si.isCall, s, si.strike, vr.sigmaBps, vr.skewK, 0, si.tau);
        return EngineCore.liab(supply, si.norm, val);
    }

    /// @notice The stress loss of the whole book (WAD) and the pool's NAV at book value (WAD).
    function stressLoss(EngineHelper h) external view returns (uint256 lossWad, int256 navWad) {
        EngineStorage.Layout storage $ = EngineStorage.layout();
        EngineHelper.Risk memory none;
        return (EngineCore.stress(h, address(0), none, 0), $.pool.navFor($.bookValue));
    }
}
