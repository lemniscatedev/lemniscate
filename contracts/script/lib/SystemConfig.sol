// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";

/// @title SystemConfig
/// @notice Deploy configuration of the option system: profile, external addresses, operator roles, timers, limits and
/// the launch names. Nothing chain-specific lives in source: every address comes from a JSON file passed at run time
/// (`DEPLOY_CONFIG` = path inside contracts/, or the raw JSON in `DEPLOY_CONFIG_JSON`).
/// @dev Profiles (todo 10 R9):
///  - fork    (chain 31337): real mainnet tokens, feeds and Uniswap pools on an anvil fork; FULL timers; admin is a
///            48h TimelockController run by `roles.safe` (any contract; the script deploys a ForkSafe when it is unset).
///  - testnet (chain 46630): the script deploys mock USDG, mock Stock Tokens and keeper-pushed mock feeds; SHORT timers
///            from `timers` (each bounded below by the contracts); admin is `roles.owner` directly (no Safe/timelock).
///  - mainnet (chain 4663): refuses any other chain; FULL timers; admin is a 48h TimelockController run by a Safe with
///            at least 3 of 5 signers.
abstract contract SystemConfig is CommonBase {
    uint8 internal constant PROFILE_FORK = 0;
    uint8 internal constant PROFILE_TESTNET = 1;
    uint8 internal constant PROFILE_MAINNET = 2;

    uint256 internal constant CHAIN_FORK = 31_337;
    uint256 internal constant CHAIN_TESTNET = 46_630;
    uint256 internal constant CHAIN_MAINNET = 4663;

    /// @dev Full (production) timers. Mainnet and fork always use exactly these.
    uint256 internal constant FULL_POOL_QUEUE_DELAY = 72 hours;
    uint32 internal constant FULL_DEPOSIT_LOCK = 24 hours;
    uint256 internal constant FULL_FEE_PERIOD = 7 days;
    uint256 internal constant FULL_TIMELOCK_DELAY = 48 hours;
    uint64 internal constant FULL_VOL_MAX_VALIDITY = 2 hours;
    uint64 internal constant FULL_VOL_MIN_POST_INTERVAL = 5 minutes;
    uint256 internal constant FULL_SPLIT_LEAD = 24 hours;
    uint256 internal constant FULL_SPLIT_TAIL = 1 hours;
    /// @dev Writer vault epoch (todo 19, phase 2): 7 days on fork and mainnet, minutes on testnet (contract minimum 5 min).
    uint256 internal constant FULL_VAULT_EPOCH = 7 days;

    /// @dev Engine param ceilings used for "unlimited" access caps (decision 24; EngineHelper.validate bounds).
    uint128 internal constant UNLIMITED_ENGINE_CAP = 1e27;
    uint256 internal constant MAINNET_SAFE_MIN_THRESHOLD = 3;
    uint256 internal constant MAINNET_SAFE_MIN_OWNERS = 5;

    struct Timers {
        uint256 poolQueueDelay;
        uint32 depositLock;
        uint256 feePeriod;
        uint256 timelockDelay; // ignored on testnet (no timelock)
        uint64 volMaxValidity;
        uint64 volMinPostInterval;
        uint256 splitLead;
        uint256 splitTail;
    }

    struct Roles {
        address owner; // testnet admin; on fork the owner of the stand-in ForkSafe when `safe` is unset
        address safe; // proposer/executor/canceller of the timelock (fork, mainnet)
        address guardian; // pause-only
        address keeper;
        address hedger;
        address volSigner;
        address treasury;
        address keepersPot;
        address hedgerPot;
        address[] depositors; // closed-beta pool allowlist
    }

    struct StockCfg {
        string name; // ticker, upper case
        address stock; // zero on testnet (mock deployed)
        address feed; // zero on testnet (mock deployed)
        address uniPool; // Uniswap v3 stock/USDG pool for the TWAP cross-check (zero on testnet)
        uint24 poolFee; // hedge route fee tier
        uint16 twapBandBps;
        uint32 twapWindow;
        uint32 maxAgeRegular;
        uint32 maxAgeExtended;
        uint16 continuityBps;
        uint256 strikeStepUsd; // whole USD
        uint256 hedgeDepthCapUsd; // whole USD, 0 = none
        uint64 volFloorBps; // 0 = VolOracle default
        uint256 mockPriceUsdE8; // testnet only: first mock feed answer (8 decimals)
    }

    struct Limits {
        uint128 maxTotalDepositsUsdg; // 6 dp; 0 = unlimited
        uint128 seriesCapWad; // 0 = unlimited (1e27)
        uint128 accountCapWad; // 0 = unlimited (1e27)
        bool publicDeposits;
    }

    /// @dev Writer vaults (todo 19, phase 2). OFF unless `.vaults.enabled` is true; even then every vault deploys closed
    /// (open = false) and the pool routes nothing until the allocator assigns slices.
    struct VaultCfg {
        bool enabled;
        uint256 epoch; // testnet only from `.vaults.epoch`; fork/mainnet always FULL_VAULT_EPOCH
    }

    struct Config {
        string profileName;
        uint8 profile;
        address usdg; // zero on testnet (mock deployed)
        address uniswapFactory; // zero = no TWAP price reference for hedge floors
        address swapRouter; // zero on testnet (mock router deployed)
        uint32 referenceWindow; // hedge floor TWAP window (UniswapV3TwapReference)
        bool handoff; // move admin to the timelock (or owner) and renounce the deployer in the same run
        Roles roles;
        Timers timers;
        Limits limits;
        StockCfg[] stocks;
        VaultCfg vaults;
    }

    // ------------------------------------------------------------------------------------------------- loading

    function loadConfig() internal view returns (Config memory c) {
        string memory json = vm.envOr("DEPLOY_CONFIG_JSON", string(""));
        if (bytes(json).length == 0) {
            string memory path = vm.envOr("DEPLOY_CONFIG", string(""));
            require(bytes(path).length != 0, "SystemConfig: set DEPLOY_CONFIG (path) or DEPLOY_CONFIG_JSON");
            json = vm.readFile(path);
        }
        c = parseConfig(json);
    }

    function parseConfig(string memory json) internal view returns (Config memory c) {
        c.profileName = vm.parseJsonString(json, ".profile");
        c.profile = profileOf(c.profileName);
        c.usdg = _addr(json, ".usdg");
        c.uniswapFactory = _addr(json, ".uniswapV3Factory");
        c.swapRouter = _addr(json, ".swapRouter");
        c.referenceWindow = uint32(_uint(json, ".referenceWindow", 1800));
        c.handoff = vm.keyExistsJson(json, ".handoff") ? vm.parseJsonBool(json, ".handoff") : true;

        c.roles.owner = _addr(json, ".roles.owner");
        c.roles.safe = _addr(json, ".roles.safe");
        c.roles.guardian = _addr(json, ".roles.guardian");
        c.roles.keeper = _addr(json, ".roles.keeper");
        c.roles.hedger = _addr(json, ".roles.hedger");
        c.roles.volSigner = _addr(json, ".roles.volSigner");
        c.roles.treasury = _addr(json, ".roles.treasury");
        c.roles.keepersPot = _addr(json, ".roles.keepersPot");
        c.roles.hedgerPot = _addr(json, ".roles.hedgerPot");
        if (vm.keyExistsJson(json, ".roles.depositors")) {
            c.roles.depositors = vm.parseJsonAddressArray(json, ".roles.depositors");
        }

        if (c.profile == PROFILE_TESTNET) {
            c.timers = Timers({
                poolQueueDelay: _uint(json, ".timers.poolQueueDelay", 0),
                depositLock: uint32(_uint(json, ".timers.depositLock", 0)),
                feePeriod: _uint(json, ".timers.feePeriod", 0),
                timelockDelay: 0,
                volMaxValidity: uint64(_uint(json, ".timers.volMaxValidity", 0)),
                volMinPostInterval: uint64(_uint(json, ".timers.volMinPostInterval", 0)),
                splitLead: _uint(json, ".timers.splitLead", 0),
                splitTail: _uint(json, ".timers.splitTail", 0)
            });
        } else {
            // Mainnet and fork: full timers, always. A config that tries to shorten one is refused.
            c.timers = fullTimers();
            require(!vm.keyExistsJson(json, ".timers"), "SystemConfig: fork/mainnet use full timers; remove .timers");
        }

        c.limits.maxTotalDepositsUsdg = uint128(_uint(json, ".limits.maxTotalDepositsUsdg", 0));
        c.limits.seriesCapWad = uint128(_uint(json, ".limits.seriesCapWad", 0));
        c.limits.accountCapWad = uint128(_uint(json, ".limits.accountCapWad", 0));
        c.limits.publicDeposits =
            vm.keyExistsJson(json, ".limits.publicDeposits") ? vm.parseJsonBool(json, ".limits.publicDeposits") : false;

        c.vaults.enabled = vm.keyExistsJson(json, ".vaults.enabled") ? vm.parseJsonBool(json, ".vaults.enabled") : false;
        if (c.profile == PROFILE_TESTNET) {
            c.vaults.epoch = _uint(json, ".vaults.epoch", 0);
        } else {
            c.vaults.epoch = FULL_VAULT_EPOCH;
            require(!vm.keyExistsJson(json, ".vaults.epoch"), "SystemConfig: fork/mainnet use the full vault epoch");
        }

        uint256 n;
        while (vm.keyExistsJson(json, string.concat(".stocks[", vm.toString(n), "]"))) ++n;
        c.stocks = new StockCfg[](n);
        for (uint256 i; i < n; ++i) {
            c.stocks[i] = _stock(json, string.concat(".stocks[", vm.toString(i), "]"));
        }
    }

    function _stock(string memory json, string memory p) private view returns (StockCfg memory s) {
        s.name = vm.parseJsonString(json, string.concat(p, ".name"));
        s.stock = _addr(json, string.concat(p, ".stock"));
        s.feed = _addr(json, string.concat(p, ".feed"));
        s.uniPool = _addr(json, string.concat(p, ".uniPool"));
        s.poolFee = uint24(_uint(json, string.concat(p, ".poolFee"), 500));
        s.twapBandBps = uint16(_uint(json, string.concat(p, ".twapBandBps"), 75));
        s.twapWindow = uint32(_uint(json, string.concat(p, ".twapWindow"), 1800));
        s.maxAgeRegular = uint32(_uint(json, string.concat(p, ".maxAgeRegular"), 26 hours));
        s.maxAgeExtended = uint32(_uint(json, string.concat(p, ".maxAgeExtended"), 26 hours));
        s.continuityBps = uint16(_uint(json, string.concat(p, ".continuityBps"), 1500));
        s.strikeStepUsd = _uint(json, string.concat(p, ".strikeStepUsd"), 0);
        s.hedgeDepthCapUsd = _uint(json, string.concat(p, ".hedgeDepthCapUsd"), 0);
        s.volFloorBps = uint64(_uint(json, string.concat(p, ".volFloorBps"), 0));
        s.mockPriceUsdE8 = _uint(json, string.concat(p, ".mockPriceUsdE8"), 0);
    }

    function _addr(string memory json, string memory key) private view returns (address) {
        if (!vm.keyExistsJson(json, key)) return address(0);
        return vm.parseJsonAddress(json, key);
    }

    function _uint(string memory json, string memory key, uint256 fallback_) private view returns (uint256) {
        if (!vm.keyExistsJson(json, key)) return fallback_;
        return vm.parseJsonUint(json, key);
    }

    // ------------------------------------------------------------------------------------------------ profiles

    function profileOf(string memory name) internal pure returns (uint8) {
        bytes32 h = keccak256(bytes(name));
        if (h == keccak256("fork")) return PROFILE_FORK;
        if (h == keccak256("testnet")) return PROFILE_TESTNET;
        if (h == keccak256("mainnet")) return PROFILE_MAINNET;
        revert("SystemConfig: profile must be fork, testnet or mainnet");
    }

    function chainOf(uint8 profile) internal pure returns (uint256) {
        if (profile == PROFILE_FORK) return CHAIN_FORK;
        if (profile == PROFILE_TESTNET) return CHAIN_TESTNET;
        return CHAIN_MAINNET;
    }

    function fullTimers() internal pure returns (Timers memory) {
        return Timers({
            poolQueueDelay: FULL_POOL_QUEUE_DELAY,
            depositLock: FULL_DEPOSIT_LOCK,
            feePeriod: FULL_FEE_PERIOD,
            timelockDelay: FULL_TIMELOCK_DELAY,
            volMaxValidity: FULL_VOL_MAX_VALIDITY,
            volMinPostInterval: FULL_VOL_MIN_POST_INTERVAL,
            splitLead: FULL_SPLIT_LEAD,
            splitTail: FULL_SPLIT_TAIL
        });
    }

    /// @notice Refuses a config that cannot be deployed on the current chain (checked before any transaction).
    function validateConfig(Config memory c) internal view {
        require(block.chainid == chainOf(c.profile), "SystemConfig: chain id does not match the profile");
        Roles memory r = c.roles;
        require(
            r.keeper != address(0) && r.hedger != address(0) && r.volSigner != address(0),
            "SystemConfig: keeper, hedger and volSigner are required"
        );
        require(
            r.keeper != r.hedger && r.keeper != r.volSigner && r.hedger != r.volSigner,
            "SystemConfig: keeper, hedger and volSigner must be three different addresses"
        );
        require(r.guardian != address(0) && r.treasury != address(0), "SystemConfig: guardian and treasury are required");
        require(c.stocks.length != 0, "SystemConfig: no stocks");
        if (c.profile == PROFILE_TESTNET) {
            require(r.owner != address(0), "SystemConfig: testnet needs roles.owner");
        } else {
            require(c.usdg != address(0) && c.usdg.code.length != 0, "SystemConfig: usdg has no code");
            require(c.swapRouter != address(0) && c.swapRouter.code.length != 0, "SystemConfig: swapRouter has no code");
            for (uint256 i; i < c.stocks.length; ++i) {
                StockCfg memory s = c.stocks[i];
                require(s.stock.code.length != 0 && s.feed.code.length != 0, "SystemConfig: stock or feed has no code");
                require(s.uniPool.code.length != 0, "SystemConfig: TWAP pool has no code");
            }
        }
        if (c.profile == PROFILE_MAINNET) {
            require(r.safe != address(0) && r.safe.code.length != 0, "SystemConfig: mainnet Safe has no code");
            require(
                _safeThreshold(r.safe) >= MAINNET_SAFE_MIN_THRESHOLD && _safeOwners(r.safe) >= MAINNET_SAFE_MIN_OWNERS,
                "SystemConfig: mainnet Safe must be at least 3-of-5"
            );
            require(
                r.keepersPot != address(0) && r.hedgerPot != address(0), "SystemConfig: mainnet fee pots are required"
            );
            require(c.uniswapFactory != address(0), "SystemConfig: mainnet needs the Uniswap v3 factory");
        }
    }

    function _safeThreshold(address safe) internal view returns (uint256) {
        (bool ok, bytes memory d) = safe.staticcall(abi.encodeWithSignature("getThreshold()"));
        return ok && d.length >= 32 ? abi.decode(d, (uint256)) : 0;
    }

    function _safeOwners(address safe) internal view returns (uint256) {
        (bool ok, bytes memory d) = safe.staticcall(abi.encodeWithSignature("getOwners()"));
        return ok && d.length >= 64 ? abi.decode(d, (address[])).length : 0;
    }
}
