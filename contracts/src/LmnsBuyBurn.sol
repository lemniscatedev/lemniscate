// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IPriceReference} from "./interfaces/IPriceReference.sol";
import {IHedgeAdapter} from "./interfaces/IHedgeAdapter.sol";

/// @title LmnsBuyBurn
/// @notice Recipient of the FeeRouter's burn bucket (spec 2.8, 5%). Buys $LMNS with the USDG it holds and sends it to
/// the dead address, but only while a TWAP source and a swap route are configured; otherwise the USDG accumulates
/// here (todo 20 R6). The $LMNS token comes from the launchpad; this contract never mints it.
/// @dev F37: only the keeper may trigger a buy (no public mempool on the chain, so nobody can wrap it in a sandwich), at
/// most `maxUsdgPerCall` per call, only while the LMNS pool's spot price is within SPOT_BAND_BPS of its TWAP, and with
/// the output floored at the TWAP less the slippage allowance. There is no withdrawal path for the USDG: it can only buy
/// $LMNS.
contract LmnsBuyBurn is AccessControl, ReentrancyGuardTransient {
    using SafeERC20 for IERC20;

    address public constant DEAD = 0x000000000000000000000000000000000000dEaD;
    uint256 private constant BPS = 10_000;
    uint256 private constant PRICE_TO_USDG = 1e30;
    uint16 public constant MAX_SLIPPAGE_BPS = 2_000;
    bytes32 public constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    /// @notice F37: a buy runs only while spot is within this band of the TWAP.
    uint256 public constant SPOT_BAND_BPS = 50;

    IERC20 public immutable token;
    IERC20 public immutable usdg;

    IPriceReference public priceSource;
    IHedgeAdapter public swapAdapter;
    uint24 public poolFee;
    uint16 public slippageBps = 300;

    /// @notice F37: most USDG one call spends (admin, timelock); keeps each buy small against the pool's depth.
    uint256 public maxUsdgPerCall = 1_000e6;
    uint256 public totalUsdgSpent;
    uint256 public totalBurned;

    event Burned(uint256 usdgIn, uint256 lmnsBurned);
    event Accumulating(uint256 usdgHeld);
    event BuyFailed(uint256 usdgIn);
    event RouteSet(address priceSource, address swapAdapter, uint24 poolFee, uint16 slippageBps);
    event MaxPerCallSet(uint256 maxUsdgPerCall);

    error InvalidParams();

    constructor(address admin, IERC20 token_, IERC20 usdg_) {
        if (admin == address(0) || address(token_) == address(0) || address(usdg_) == address(0) || token_ == usdg_) {
            revert InvalidParams();
        }
        token = token_;
        usdg = usdg_;
        _grantRole(DEFAULT_ADMIN_ROLE, admin);
    }

    /// @notice Buys and burns with up to `maxUsdg` of the held USDG. Returns 0 (and keeps the USDG) when no TWAP
    /// source or route is configured, the TWAP is unavailable, or the swap fails; never reverts for those.
    /// Keeper only (F37); at most `maxUsdgPerCall`; skipped while spot is off the TWAP.
    function buyAndBurn(uint256 maxUsdg) external nonReentrant onlyRole(KEEPER_ROLE) returns (uint256 burned) {
        uint256 amount = usdg.balanceOf(address(this));
        if (maxUsdg < amount) amount = maxUsdg;
        if (maxUsdgPerCall < amount) amount = maxUsdgPerCall;
        uint256 price = _price();
        IHedgeAdapter adapter = swapAdapter;
        if (amount == 0 || price == 0 || address(adapter) == address(0) || !_spotNearTwap(priceSource, price)) {
            emit Accumulating(usdg.balanceOf(address(this)));
            return 0;
        }
        uint256 minOut = Math.mulDiv(amount, PRICE_TO_USDG * (BPS - slippageBps), price * BPS);
        if (minOut == 0) {
            emit Accumulating(usdg.balanceOf(address(this)));
            return 0;
        }
        uint256 deadBefore = token.balanceOf(DEAD);
        usdg.forceApprove(address(adapter), amount);
        try adapter.swapExactIn(address(usdg), address(token), poolFee, amount, minOut, DEAD) {
            burned = token.balanceOf(DEAD) - deadBefore;
            totalUsdgSpent += amount;
            totalBurned += burned;
            emit Burned(amount, burned);
        } catch {
            emit BuyFailed(amount);
        }
        usdg.forceApprove(address(adapter), 0);
    }

    /// @notice Admin (timelock): TWAP source and swap route. Zero source or adapter = accumulate only.
    function setRoute(IPriceReference source, IHedgeAdapter adapter, uint24 fee, uint16 slippage)
        external
        onlyRole(DEFAULT_ADMIN_ROLE)
    {
        if (slippage > MAX_SLIPPAGE_BPS) revert InvalidParams();
        if (address(source) != address(0) && address(source).code.length == 0) revert InvalidParams();
        if (address(adapter) != address(0) && (address(adapter).code.length == 0 || fee == 0)) revert InvalidParams();
        priceSource = source;
        swapAdapter = adapter;
        poolFee = fee;
        slippageBps = slippage;
        emit RouteSet(address(source), address(adapter), fee, slippage);
    }

    /// @notice Admin (timelock): the most USDG one buy may spend (F37). Must be non-zero.
    function setMaxUsdgPerCall(uint256 cap) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (cap == 0) revert InvalidParams();
        maxUsdgPerCall = cap;
        emit MaxPerCallSet(cap);
    }

    /// @dev F37: true when the price source's spot price is within SPOT_BAND_BPS of `twap`. A source without
    /// `spotPrice`, or no answer, counts as off: the swap is skipped rather than made blind.
    function _spotNearTwap(IPriceReference src, uint256 twap) private view returns (bool) {
        (bool ok, bytes memory ret) =
            address(src).staticcall(abi.encodeWithSignature("spotPrice(address,uint24)", address(token), poolFee));
        if (!ok || ret.length < 32) return false;
        uint256 spot = abi.decode(ret, (uint256));
        if (spot == 0) return false;
        uint256 diff = spot > twap ? spot - twap : twap - spot;
        return diff * BPS <= twap * SPOT_BAND_BPS;
    }

    function _price() private view returns (uint256) {
        IPriceReference src = priceSource;
        if (address(src) == address(0)) return 0;
        try src.referencePrice(address(token), poolFee) returns (uint256 p) {
            return p;
        } catch {
            return 0;
        }
    }
}
