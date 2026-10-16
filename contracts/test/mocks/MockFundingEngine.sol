// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ISeriesRegistry} from "../../src/interfaces/ISeriesRegistry.sol";
import {IOptionToken} from "../../src/interfaces/IOptionToken.sol";
import {Series} from "../../src/libs/OptionTypes.sol";
import {Funding} from "../../src/libs/Funding.sol";

/// @dev Engine stand-in: accrue(id) applies Funding.step at a settable mark and stores it in the registry. Counts calls,
/// records the watched balances at call time (to prove accrue runs before the balance moves) and can be told to revert.
contract MockFundingEngine {
    error AccrueFailed();

    ISeriesRegistry public immutable registry;
    uint256 public vWad;
    uint256 public payoffWad;
    bool public failAccrue;
    uint256 public accrueCalls;

    address public watched;
    uint256 public watchedBalanceAtAccrue;
    uint256 public supplyAtAccrue;

    constructor(ISeriesRegistry registry_) {
        registry = registry_;
    }

    function setMark(uint256 v, uint256 payoff) external {
        vWad = v;
        payoffWad = payoff;
    }

    function setFail(bool fail) external {
        failAccrue = fail;
    }

    function watch(address who) external {
        watched = who;
    }

    function accrue(bytes32 id) public {
        if (failAccrue) revert AccrueFailed();
        ++accrueCalls;
        Series memory s = registry.seriesOf(id);
        if (watched != address(0)) watchedBalanceAtAccrue = IERC20(s.token).balanceOf(watched);
        supplyAtAccrue = IERC20(s.token).totalSupply();
        if (block.timestamp <= s.lastAccrual) return;
        uint256 n = Funding.step(s.norm, vWad, payoffWad, block.timestamp - s.lastAccrual, s.tauSeconds);
        registry.storeAccrual(id, uint128(n), uint64(block.timestamp));
    }

    function mint(bytes32 id, address to, uint256 amount) external {
        IOptionToken(registry.seriesOf(id).token).mint(to, amount);
    }

    function burn(bytes32 id, address from, uint256 amount) external {
        IOptionToken(registry.seriesOf(id).token).burn(from, amount);
    }
}
