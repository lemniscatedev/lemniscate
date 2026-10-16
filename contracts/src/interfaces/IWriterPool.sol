// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC4626} from "@openzeppelin/contracts/interfaces/IERC4626.sol";
import {IHedgeAdapter} from "./IHedgeAdapter.sol";
import {IPriceReference} from "./IPriceReference.sol";
import {ILemniscateEngine} from "./ILemniscateEngine.sol";

interface IWriterPool is IERC4626, IAccessControl {
    error InvalidAdmin();
    error InvalidEngine();
    error InvalidParams();
    error InvalidRoute();
    error InvalidMarketId();
    error NotEngine();
    error NotDepositor();
    error VaultInsolvent();
    error DepositCapReached();
    error InsufficientLiquidity();
    error ExposureLimitReached();
    error WithdrawalLocked();
    error RegimePaused();

    event DepositorUpdated(address indexed account, bool allowed);
    event PublicDepositsUpdated(bool enabled);
    event ParamsUpdated(
        uint32 lockSeconds,
        uint16 cashBufferBps,
        uint16 hedgeRatioBps,
        uint16 rebalanceThresholdBps,
        uint16 maxHedgeSlippageBps,
        uint128 minHedgeTradeUsdg,
        uint128 maxTotalDeposits
    );
    event HedgeRouteUpdated(uint8 indexed id, address indexed adapter, uint24 poolFee);
    event Hedged(uint8 indexed id, bool buy, uint256 amountIn, uint256 amountOut, uint256 hedgeUnitsAfter);
    event CashRaised(uint8 indexed id, uint256 stockSold, uint256 usdgOut);
    event HedgeUnitsSynced(uint8 indexed id, uint256 hedgeUnits);
    event NavGuardUpdated(uint16 openBps, uint16 closedBps);
    event PriceReferenceUpdated(address indexed ref);

    function KEEPER_ROLE() external view returns (bytes32);

    function engine() external view returns (ILemniscateEngine);

    function initialize(address admin, IERC20 usdg, ILemniscateEngine engine_) external;

    function navView() external view returns (int256 navWad);

    function navPerShareWad() external view returns (uint256);

    function navBand() external view returns (int256 navWad, int256 lowWad, int256 highWad);

    function navFor(uint256 liabilityWad, uint256[] memory spots) external view returns (int256 navWad);

    function setNavGuard(uint16 openBps, uint16 closedBps) external;

    function setPriceReference(IPriceReference ref) external;

    function priceReference() external view returns (IPriceReference);

    function navGuardOpenBps() external view returns (uint16);

    function navGuardClosedBps() external view returns (uint16);

    function setDepositor(address account, bool allowed) external;

    function setPublicDeposits(bool enabled) external;

    function setParams(
        uint32 lockSeconds,
        uint16 cashBufferBps,
        uint16 hedgeRatioBps,
        uint16 rebalanceThresholdBps,
        uint16 maxHedgeSlippageBps,
        uint128 minHedgeTradeUsdg,
        uint128 maxTotalDeposits
    ) external;

    function setHedgeRoute(uint8 id, IHedgeAdapter adapter, uint24 poolFee) external;

    function syncHedgeUnits(uint8 id) external;

    function isDepositor(address account) external view returns (bool);

    function publicDeposits() external view returns (bool);

    function lockSeconds() external view returns (uint32);

    function cashBufferBps() external view returns (uint16);

    function hedgeRatioBps() external view returns (uint16);

    function rebalanceThresholdBps() external view returns (uint16);

    function maxHedgeSlippageBps() external view returns (uint16);

    function minHedgeTradeUsdg() external view returns (uint128);

    function maxTotalDeposits() external view returns (uint128);

    function routeForMarket(uint8 id) external view returns (IHedgeAdapter adapter, uint24 poolFee);

    function unlockTime(address account) external view returns (uint256);

    function pay(address to, uint256 usdgAmount, uint8 preferMarket) external returns (uint256 paid);

    function rebalance(uint8 id) external returns (int256 unitsDelta);

    function hedgeUnits(uint8 id) external view returns (uint256);
}
