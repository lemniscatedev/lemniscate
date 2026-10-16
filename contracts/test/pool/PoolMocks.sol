// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPool} from "../../src/interfaces/IPool.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {PriceReading, SessionKind} from "../../src/libs/OptionTypes.sol";

/// @dev Engine stand-in for the pool: holds the two views the pool reads (totalLiability, netGreeks) and drives the
/// engine-only callbacks the way the engine will (buyer USDG straight to the pool, then onSale; pay on sells).
contract MockPoolEngine {
    IERC20 public immutable usdg;
    IPool public pool;
    uint256 public totalLiability; // WAD
    mapping(address stock => int256) public deltaOf;
    mapping(address stock => int256) public gammaOf;

    constructor(IERC20 usdg_) {
        usdg = usdg_;
    }

    function setPool(IPool pool_) external {
        pool = pool_;
    }

    function setLiability(uint256 wad) external {
        totalLiability = wad;
    }

    function setGreeks(address stock, int256 delta, int256 gamma) external {
        deltaOf[stock] = delta;
        gammaOf[stock] = gamma;
    }

    function netGreeks(address stock) external view returns (int256, int256, int256) {
        return (deltaOf[stock], gammaOf[stock], 0);
    }

    /// @dev A buy: `usdgIn` from the caller to the pool, liability grows by `liabilityAddWad`.
    function buy(bytes32 id, uint256 usdgIn, uint256 spreadUsdg, uint256 liabilityAddWad) external {
        usdg.transferFrom(msg.sender, address(pool), usdgIn);
        totalLiability += liabilityAddWad;
        pool.onSale(id, usdgIn, spreadUsdg);
    }

    /// @dev A sell: liability falls by `liabilityRemoveWad`, the pool pays `usdgOut` to `to`.
    function sell(address to, uint256 usdgOut, uint256 spreadUsdg, uint256 liabilityRemoveWad) external {
        totalLiability -= liabilityRemoveWad;
        pool.pay(to, usdgOut, spreadUsdg);
    }

    /// @dev An accrual: in-kind funding moved `fundingUsdg` of value from holders to the pool.
    function accrue(bytes32 id, uint256 fundingUsdg) external {
        uint256 wad = fundingUsdg * 1e12;
        totalLiability = totalLiability > wad ? totalLiability - wad : 0;
        pool.onFunding(id, fundingUsdg);
    }
}

/// @dev PriceGuard stand-in: per-stock S, session and freshness. `read` only (no readLite).
contract MockPoolPriceGuard {
    struct P {
        uint256 s;
        SessionKind session;
        bool fresh;
        bool known;
    }

    mapping(address => P) public p;
    mapping(address => uint256) public lastGood;

    function set(address stock, uint256 s, SessionKind session, bool fresh) external {
        p[stock] = P(s, session, fresh, true);
        if (s != 0) lastGood[stock] = s;
    }

    function read(address stock) public view returns (PriceReading memory r) {
        P memory x = p[stock];
        require(x.known, "unknown stock");
        r = PriceReading({s: x.s, session: x.session, fresh: x.fresh, buysPaused: false, updatedAt: block.timestamp});
    }

    function config(address stock) external view returns (IPriceGuard.StockConfig memory c) {
        require(p[stock].known, "unknown stock");
        c.enabled = true;
    }

    function lastGoodPrice(address stock) external view returns (uint256, uint256) {
        return (lastGood[stock], block.timestamp);
    }
}

/// @dev Same guard with the additive `readLite` (decision 15) returning its own price, to prove the pool prefers it.
contract MockPoolPriceGuardLite is MockPoolPriceGuard {
    mapping(address => uint256) public liteS;

    function setLite(address stock, uint256 s) external {
        liteS[stock] = s;
    }

    function readLite(address stock) external view returns (PriceReading memory r) {
        r = read(stock);
        r.s = liteS[stock];
    }
}
