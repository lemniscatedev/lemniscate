// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {Speed} from "../../src/libs/OptionTypes.sol";
import {EngineBase} from "../engine/EngineBase.sol";

/// @notice Review findings F09/F13 (MEDIUM): a stale vol post priced sells at sigma x 1.2, above the pool's own mark,
/// so any vol-engine lapse paid every holder ~10-18% over fair value and a buy-before/sell-after round trip made ~10%.
contract F09StaleVolTest is EngineBase {
    function test_F13_buyBeforeLapseSellAfterLoses() public {
        bytes32 id = _list(address(nvda), true, 100e18, DAILY);
        uint64 until = uint64(vm.getBlockTimestamp() + 10 minutes);
        vol.set(address(nvda), Speed.DAILY, 5000, 0, until);
        vm.warp(until); // the last block a buy is allowed
        (uint256 cost, uint256 tokens) = _buy(alice, id, 10_000e18);
        vm.warp(until + 1); // vol is stale
        uint256 proceeds = _sell(alice, id, tokens);
        assertLt(proceeds, cost, "round trip across a vol lapse must lose");
    }

    function test_F09_staleVolBidNeverAboveTheMark() public {
        bytes32 id = _list(address(nvda), true, 102e18, DAILY);
        _buy(alice, id, 10_000e18);
        vol.set(address(nvda), Speed.DAILY, 5000, 0, uint64(vm.getBlockTimestamp() + 10 minutes));
        skip(2 hours); // the vol engine is down
        (uint256 vMark,,,) = engine.vMark(id);
        IOptionEngine.Quote memory q = engine.quote(id, 1_000e18, false);
        assertLe(q.vMarkWad, vMark, "a stale vol post must not raise the bid above the liability mark");
    }
}
