// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script} from "forge-std/Script.sol";
import {console2} from "forge-std/console2.sol";

/// @dev Uniswap v3 surfaces used by the operational scripts.
interface IUniswapV3FactoryOps {
    function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool);
}

interface IUniswapV3PoolOps {
    function slot0()
        external
        view
        returns (
            uint160 sqrtPriceX96,
            int24 tick,
            uint16 observationIndex,
            uint16 observationCardinality,
            uint16 observationCardinalityNext,
            uint8 feeProtocol,
            bool unlocked
        );

    function liquidity() external view returns (uint128);

    function increaseObservationCardinalityNext(uint16 observationCardinalityNext) external;
}

interface IRouterFactoryOps {
    function factory() external view returns (address);
}

interface IUUPSOps {
    function upgradeToAndCall(address newImplementation, bytes calldata data) external payable;

    function proxiableUUID() external view returns (bytes32);
}

/// @title LemniscateScript
/// @notice Shared helpers for the operational scripts: expected-address loading, ERC-1967 reads, Uniswap pool lookup.
/// @dev Addresses come from, in increasing priority: the public chain constants below (USDG only), a deployment file (`DEPLOYMENT_FILE` path inside the project or the raw
/// JSON in `DEPLOYMENT_JSON`, using the app's deployment schema), and per-address environment overrides. Operator
/// accounts (admin, keeper, Safe, timelock) are never defaulted: they only come from the file or the environment.
abstract contract LemniscateScript is Script {
    bytes32 internal constant IMPLEMENTATION_SLOT = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc; // not-a-key
    /// @dev OpenZeppelin v5 Initializable storage (namespace "openzeppelin.storage.Initializable").
    bytes32 internal constant INITIALIZABLE_SLOT = 0xf0c57e16840df040f15088dc2f81fe391c3923bec73e23a9662efc9c229c6a00; // not-a-key
    bytes32 internal constant DEFAULT_ADMIN_ROLE = bytes32(0);
    bytes32 internal constant KEEPER_ROLE = keccak256("KEEPER_ROLE");
    bytes32 internal constant GUARDIAN_ROLE = keccak256("GUARDIAN_ROLE");
    uint256 internal constant ROBINHOOD_MAINNET = 4663;

    struct Market {
        uint8 id;
        string symbol;
        address token;
        address stock;
        address feed;
        uint256 scale;
        uint24 poolFee;
    }

    struct Deployment {
        uint256 chainId;
        address engine;
        address vault;
        address marketHours;
        address lens;
        address hedgeAdapter;
        address usdg;
        address engineImpl;
        address vaultImpl;
        address marketHoursImpl;
        address admin;
        address keeper;
        uint256 deployBlock;
        Market[] markets;
        string source;
    }

    // ---------------------------------------------------------------- deployment loading

    function loadDeployment() internal view returns (Deployment memory d) {
        d.chainId = block.chainid;
        d.source = "env";
        if (block.chainid == ROBINHOOD_MAINNET) {
            _mainnetDefaults(d);
            d.source = "built-in mainnet defaults";
        }

        string memory json = vm.envOr("DEPLOYMENT_JSON", string(""));
        string memory path = vm.envOr("DEPLOYMENT_FILE", string(""));
        if (bytes(json).length == 0 && bytes(path).length != 0) {
            json = vm.readFile(path);
            d.source = path;
        } else if (bytes(json).length != 0) {
            d.source = "DEPLOYMENT_JSON";
        }
        if (bytes(json).length != 0) _applyJson(d, json);

        d.engine = vm.envOr("ENGINE", d.engine);
        d.vault = vm.envOr("VAULT", d.vault);
        d.marketHours = vm.envOr("MARKET_HOURS", d.marketHours);
        d.lens = vm.envOr("LENS", d.lens);
        d.hedgeAdapter = vm.envOr("HEDGE_ADAPTER", d.hedgeAdapter);
        d.usdg = vm.envOr("USDG", d.usdg);
        d.engineImpl = vm.envOr("ENGINE_IMPL", d.engineImpl);
        d.vaultImpl = vm.envOr("VAULT_IMPL", d.vaultImpl);
        d.marketHoursImpl = vm.envOr("MARKET_HOURS_IMPL", d.marketHoursImpl);
        d.admin = vm.envOr("ADMIN", d.admin);
        d.keeper = vm.envOr("KEEPER", d.keeper);

        require(d.chainId == block.chainid, "LemniscateScript: deployment chainId does not match the RPC chain");
        require(d.engine != address(0) && d.vault != address(0), "LemniscateScript: ENGINE and VAULT are required");
    }

    function _applyJson(Deployment memory d, string memory json) private view {
        if (vm.keyExistsJson(json, ".chainId")) d.chainId = vm.parseJsonUint(json, ".chainId");
        if (vm.keyExistsJson(json, ".deployBlock")) d.deployBlock = vm.parseJsonUint(json, ".deployBlock");
        d.admin = _jsonAddr(json, ".admin", d.admin);
        d.keeper = _jsonAddr(json, ".keeper", d.keeper);
        d.engine = _jsonAddr(json, ".contracts.engine", d.engine);
        d.vault = _jsonAddr(json, ".contracts.vault", d.vault);
        d.marketHours = _jsonAddr(json, ".contracts.marketHours", d.marketHours);
        d.lens = _jsonAddr(json, ".contracts.lens", d.lens);
        d.hedgeAdapter = _jsonAddr(json, ".contracts.hedgeAdapter", d.hedgeAdapter);
        d.usdg = _jsonAddr(json, ".contracts.usdg", d.usdg);
        d.engineImpl = _jsonAddr(json, ".contracts.engineImpl", d.engineImpl);
        d.vaultImpl = _jsonAddr(json, ".contracts.vaultImpl", d.vaultImpl);
        d.marketHoursImpl = _jsonAddr(json, ".contracts.marketHoursImpl", d.marketHoursImpl);

        if (!vm.keyExistsJson(json, ".markets")) return;
        uint256 count;
        while (vm.keyExistsJson(json, string.concat(".markets[", vm.toString(count), "]"))) ++count;
        d.markets = new Market[](count);
        for (uint256 i; i < count; ++i) {
            string memory p = string.concat(".markets[", vm.toString(i), "]");
            d.markets[i] = Market({
                id: uint8(vm.parseJsonUint(json, string.concat(p, ".id"))),
                symbol: vm.parseJsonString(json, string.concat(p, ".symbol")),
                token: vm.parseJsonAddress(json, string.concat(p, ".token")),
                stock: vm.parseJsonAddress(json, string.concat(p, ".stock")),
                feed: vm.parseJsonAddress(json, string.concat(p, ".feed")),
                scale: vm.parseJsonUint(json, string.concat(p, ".scale")),
                poolFee: uint24(vm.parseJsonUint(json, string.concat(p, ".poolFee")))
            });
        }
    }

    function _jsonAddr(string memory json, string memory key, address fallback_) private view returns (address) {
        if (!vm.keyExistsJson(json, key)) return fallback_;
        return vm.parseJsonAddress(json, key);
    }

    /// @dev Public chain constants only. Contract addresses of a deployment come from the deployment file or the
    /// environment, never from source.
    function _mainnetDefaults(Deployment memory d) private pure {
        d.usdg = 0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168;
    }

    // ---------------------------------------------------------------- chain reads

    function implementationOf(address proxy) internal view returns (address) {
        return address(uint160(uint256(vm.load(proxy, IMPLEMENTATION_SLOT))));
    }

    /// @dev True when the implementation's OpenZeppelin v5 initializer version is locked at type(uint64).max.
    function initializersDisabled(address implementation) internal view returns (bool) {
        uint256 raw = uint256(vm.load(implementation, INITIALIZABLE_SLOT));
        return uint64(raw) == type(uint64).max;
    }

    /// @notice Uniswap v3 factory: `UNISWAP_V3_FACTORY`, else `SWAP_ROUTER.factory()`, else the router immutable
    /// embedded in the hedge adapter's runtime code (the adapter exposes no getter).
    function uniswapFactory(address hedgeAdapter) internal view returns (address factory) {
        factory = vm.envOr("UNISWAP_V3_FACTORY", address(0));
        if (factory != address(0)) return factory;
        address router = vm.envOr("SWAP_ROUTER", address(0));
        if (router != address(0)) return IRouterFactoryOps(router).factory();
        if (hedgeAdapter == address(0)) return address(0);

        bytes memory code = hedgeAdapter.code;
        for (uint256 i; i + 32 < code.length; ++i) {
            if (code[i] != 0x7f) continue; // PUSH32: immutables are inlined as 32-byte words
            bool padded = true;
            for (uint256 j = 1; j <= 12; ++j) {
                if (code[i + j] != 0) {
                    padded = false;
                    break;
                }
            }
            if (!padded) continue;
            uint160 raw;
            for (uint256 j = 13; j <= 32; ++j) {
                raw = (raw << 8) | uint160(uint8(code[i + j]));
            }
            address candidate = address(raw);
            if (candidate.code.length == 0) continue;
            try IRouterFactoryOps(candidate).factory() returns (address f) {
                if (f.code.length != 0) return f;
            } catch {}
        }
    }

    function poolOf(address factory, address stock, address usdg, uint24 fee) internal view returns (address pool) {
        if (factory == address(0) || fee == 0) return address(0);
        try IUniswapV3FactoryOps(factory).getPool(stock, usdg, fee) returns (address p) {
            pool = p;
        } catch {}
    }

    function cardinalityOf(address pool) internal view returns (uint16 current, uint16 next) {
        if (pool == address(0) || pool.code.length == 0) return (0, 0);
        try IUniswapV3PoolOps(pool).slot0() returns (uint160, int24, uint16, uint16 c, uint16 n, uint8, bool) {
            return (c, n);
        } catch {}
    }

    function bpsDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        if (a == 0 || b == 0) return type(uint256).max;
        uint256 diff = a > b ? a - b : b - a;
        return diff * 10_000 / b;
    }

    function logDeployment(Deployment memory d) internal pure {
        console2.log("deployment source:", d.source);
        console2.log("  engine     ", d.engine);
        console2.log("  vault      ", d.vault);
        console2.log("  marketHours", d.marketHours);
        console2.log("  lens       ", d.lens);
        console2.log("  adapter    ", d.hedgeAdapter);
        console2.log("  usdg       ", d.usdg);
    }
}
