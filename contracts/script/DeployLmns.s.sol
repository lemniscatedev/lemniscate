// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LmnsStaking} from "../src/LmnsStaking.sol";
import {LmnsBuyBurn} from "../src/LmnsBuyBurn.sol";
import {SystemConfig} from "./lib/SystemConfig.sol";

/// @title DeployLmns
/// @notice Phase 2 (todo 20): deploys LmnsStaking and LmnsBuyBurn for an existing system once the launchpad has issued
/// $LMNS. Our contracts never mint the token (decision 23); its address is an input. Deploying changes nothing in the
/// live system: the admin (timelock on fork and mainnet) then turns the module on with the calls this script prints.
///
/// Usage (sign with Foundry's own flags; nothing here reads keys):
///   LMNS_PROFILE=<fork|testnet|mainnet> LMNS_TOKEN=<launchpad token> LMNS_ADMIN=<timelock or testnet owner> \
///   LMNS_USDG=<usdg> LMNS_POOL=<writer pool> forge script script/DeployLmns.s.sol --rpc-url <rpc> [--broadcast]
/// Timers (todo 10 R8): fork and mainnet always use the full values (14-day unstake, 7-day reward stream = the
/// FeeRouter period, 1-day minimum stake age to claim) and refuse overrides. Testnet reads LMNS_UNSTAKE_DELAY,
/// LMNS_REWARD_DURATION and LMNS_MIN_CLAIM_AGE (defaults 10 min / 15 min / 2 min); the contract enforces its hard
/// minimums (5 min / 5 min / 1 min).
contract DeployLmns is Script, SystemConfig {
    uint256 internal constant FULL_UNSTAKE_DELAY = 14 days;
    uint256 internal constant FULL_REWARD_DURATION = FULL_FEE_PERIOD;
    uint256 internal constant FULL_MIN_CLAIM_AGE = 1 days;

    struct LmnsParams {
        uint8 profile;
        address admin;
        address token;
        address usdg;
        address pool;
        uint256 unstakeDelay; // testnet only; 0 on fork and mainnet
        uint256 rewardDuration; // testnet only
        uint256 minClaimAge; // testnet only
    }

    function run() external returns (LmnsStaking staking, LmnsBuyBurn burn) {
        LmnsParams memory p;
        p.profile = profileOf(vm.envString("LMNS_PROFILE"));
        require(block.chainid == chainOf(p.profile), "DeployLmns: profile does not match the RPC chain");
        p.admin = vm.envAddress("LMNS_ADMIN");
        p.token = vm.envAddress("LMNS_TOKEN");
        p.usdg = vm.envAddress("LMNS_USDG");
        p.pool = vm.envAddress("LMNS_POOL");
        if (p.profile == PROFILE_TESTNET) {
            p.unstakeDelay = vm.envOr("LMNS_UNSTAKE_DELAY", uint256(10 minutes));
            p.rewardDuration = vm.envOr("LMNS_REWARD_DURATION", uint256(15 minutes));
            p.minClaimAge = vm.envOr("LMNS_MIN_CLAIM_AGE", uint256(2 minutes));
        } else {
            p.unstakeDelay = vm.envOr("LMNS_UNSTAKE_DELAY", uint256(0));
            p.rewardDuration = vm.envOr("LMNS_REWARD_DURATION", uint256(0));
            p.minClaimAge = vm.envOr("LMNS_MIN_CLAIM_AGE", uint256(0));
        }
        vm.startBroadcast();
        (staking, burn) = _deployLmns(p);
        vm.stopBroadcast();
        console2.log("  LmnsStaking ", address(staking));
        console2.log("  LmnsBuyBurn ", address(burn));
        console2.log("  unstake delay (s)", staking.UNSTAKE_DELAY());
        console2.log("Admin calls to turn the module on (schedule through the timelock on fork/mainnet):");
        console2.log("Slippage: the LMNS pool fee plus 50 bps (150 for a 1% pool), at most MAX_LMNS_SLIPPAGE_BPS (F37).");
        console2.log("  staking.setSlashRoute(<LMNS/USDG TWAP reference>, <hedge adapter>, <pool fee>, <slippage>)");
        console2.log("  staking.setCoverCap(<USDG one swap raises inside the slippage floor, measured on the LMNS pool>)");
        console2.log("  staking.setTiers([...])");
        console2.log("  burn.setRoute(<LMNS/USDG TWAP reference>, <hedge adapter>, <pool fee>, <slippage>)");
        console2.log("  burn.grantRole(KEEPER_ROLE, <keeper>); burn.setMaxUsdgPerCall(<a small share of pool depth>)");
        console2.log("After the timelock runs them: lmnsFailures(staking, burn) must return nothing (BAT-3 / DEP-2).");
        console2.log("  pool.setStaking(staking)");
        console2.log("  engine.setFeeTiers(staking)");
        console2.log('  feeRouter.setRecipient("stakers", staking); feeRouter.setRecipient("burn", burn)');
    }

    /// @notice F37 / BAT-3: the most slippage either LMNS swap may allow once routed (pool fee + 50 bps on a 1% pool).
    uint16 internal constant MAX_LMNS_SLIPPAGE_BPS = 150;
    uint256 internal constant MAX_BURN_PER_CALL_USDG = 10_000e6;

    /// @notice Post-activation check of the LMNS module (BAT-3 / DEP-2): each misconfiguration by name, empty when sound.
    function lmnsFailures(LmnsStaking staking, LmnsBuyBurn burn) public view returns (string[] memory out) {
        string[6] memory f;
        uint256 n;
        if (address(staking.swapAdapter()) != address(0)) {
            if (staking.slippageBps() > MAX_LMNS_SLIPPAGE_BPS) f[n++] = "LMNS_SLASH_SLIPPAGE";
            if (!_hasSpot(address(staking.priceSource()), address(staking.token()), staking.poolFee())) {
                f[n++] = "LMNS_SLASH_NO_SPOT";
            }
            if (staking.coverCapUsdg() == 0) f[n++] = "LMNS_COVER_CAP_UNSET";
        }
        if (address(burn.swapAdapter()) != address(0)) {
            if (burn.slippageBps() > MAX_LMNS_SLIPPAGE_BPS) f[n++] = "LMNS_BURN_SLIPPAGE";
            if (!_hasSpot(address(burn.priceSource()), address(burn.token()), burn.poolFee())) f[n++] = "LMNS_BURN_NO_SPOT";
            if (burn.maxUsdgPerCall() > MAX_BURN_PER_CALL_USDG) f[n++] = "LMNS_BURN_PER_CALL";
        }
        out = new string[](n);
        for (uint256 i; i < n; ++i) {
            out[i] = f[i];
        }
    }

    function _hasSpot(address src, address token, uint24 fee) private view returns (bool) {
        (bool ok, bytes memory ret) = src.staticcall(abi.encodeWithSignature("spotPrice(address,uint24)", token, fee));
        return ok && ret.length >= 32 && abi.decode(ret, (uint256)) != 0;
    }

    /// @notice The timers a profile deploys: full on fork and mainnet (overrides refused), as given on testnet.
    function lmnsTimers(LmnsParams memory p) internal pure returns (uint256 unstake, uint256 stream, uint256 claimAge) {
        if (p.profile == PROFILE_TESTNET) return (p.unstakeDelay, p.rewardDuration, p.minClaimAge);
        require(
            p.unstakeDelay == 0 && p.rewardDuration == 0 && p.minClaimAge == 0,
            "DeployLmns: fork/mainnet use full timers; unset LMNS_* timer overrides"
        );
        return (FULL_UNSTAKE_DELAY, FULL_REWARD_DURATION, FULL_MIN_CLAIM_AGE);
    }

    function _deployLmns(LmnsParams memory p) internal returns (LmnsStaking staking, LmnsBuyBurn burn) {
        require(p.token != address(0), "DeployLmns: LMNS_TOKEN unset (the launchpad issues it)");
        (uint256 unstake, uint256 stream, uint256 claimAge) = lmnsTimers(p);
        staking = new LmnsStaking(p.admin, IERC20(p.token), IERC20(p.usdg), p.pool, unstake, stream, claimAge);
        burn = new LmnsBuyBurn(p.admin, IERC20(p.token), IERC20(p.usdg));
    }
}
