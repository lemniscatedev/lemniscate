// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {CommonBase} from "forge-std/Base.sol";
import {VmSafe} from "forge-std/Vm.sol";

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
///            at least 3 of 5 signers. Owner decision (2026-10-28): the timelock may instead be run by one plain EOA, but
///            only with `ALLOW_EOA_OWNER=1` in the environment (never from the JSON); an EIP-7702 delegated EOA is always
///            refused. Everything else stays strict: 48h delay, the timelock the only admin, the deployer renounced.
abstract contract SystemConfig is CommonBase {
    uint8 internal constant PROFILE_FORK = 0;
    uint8 internal constant PROFILE_TESTNET = 1;
    uint8 internal constant PROFILE_MAINNET = 2;

    uint256 internal constant CHAIN_FORK = 31_337;
    uint256 internal constant CHAIN_TESTNET = 46_630;
    uint256 internal constant CHAIN_MAINNET = 4663;

    /// @notice Armed-flag guard for every script that broadcasts (gap audit 19). A funded key in an
    /// agent's shell must not be able to reach the real chains by accident. On mainnet (4663) and testnet (46630) a
    /// broadcast or resume needs BOTH `LEMNISCATE_ALLOW_REAL_DEPLOY=1` in the environment AND the file named by
    /// `LEMNISCATE_ALLOW_FILE` to exist (a path inside contracts/, git-ignored, created by the owner for the run and
    /// deleted after). A plain simulation (no `--broadcast`), a fork or anvil under another chain id, and `forge test`
    /// stay free. Call it first in every `run()` that reaches `vm.startBroadcast`.
    function requireRealDeployArmed(string memory who) internal view {
        bool broadcasting = vm.isContext(VmSafe.ForgeContext.ScriptBroadcast) || vm.isContext(VmSafe.ForgeContext.ScriptResume);
        requireArmedFor(
            block.chainid,
            broadcasting,
            vm.envOr("LEMNISCATE_ALLOW_REAL_DEPLOY", string("")),
            vm.envOr("LEMNISCATE_ALLOW_FILE", string("")),
            who
        );
    }

    /// @dev The decision of `requireRealDeployArmed`, with the chain id, broadcast context and the two environment values
    /// as arguments so a test reaches every branch without touching the process environment.
    function requireArmedFor(uint256 chainId, bool broadcasting, string memory flag, string memory file, string memory who)
        internal
        view
    {
        if (!broadcasting || (chainId != CHAIN_MAINNET && chainId != CHAIN_TESTNET)) return;
        require(
            keccak256(bytes(flag)) == keccak256("1"),
            string.concat(who, ": refusing to broadcast to a real chain: set LEMNISCATE_ALLOW_REAL_DEPLOY=1 (owner's deploy command only)")
        );
        require(
            bytes(file).length != 0, string.concat(who, ": refusing to broadcast to a real chain: set LEMNISCATE_ALLOW_FILE to the arming file")
        );
        bool present;
        try vm.exists(file) returns (bool found) {
            present = found;
        } catch {
            revert(string.concat(who, ": LEMNISCATE_ALLOW_FILE must be a readable path inside contracts/"));
        }
        require(present, string.concat(who, ": refusing to broadcast to a real chain: the LEMNISCATE_ALLOW_FILE file does not exist"));
    }

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
        address safe; // timelock owner: proposer/executor/canceller (fork, mainnet). JSON `.roles.timelockOwner`, or the
        // older key `.roles.safe`. A Safe (mainnet: >= 3-of-5), or a plain EOA only with ALLOW_EOA_OWNER=1.
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
        /// @dev EOA owner escape hatch: true only from the environment (`ALLOW_EOA_OWNER=1`), never from the JSON. Off by
        /// default. Testnet: lets `roles.owner` be a plain EOA (else a real Safe, see `ownerSafeProblem`). Fork and mainnet:
        /// lets the timelock owner (`roles.safe` / `roles.timelockOwner`) be a plain EOA behind the 48h timelock (else a
        /// contract on fork, a Safe of at least 3-of-5 on mainnet; see `timelockOwnerProblem`).
        bool allowEoaOwner;
        /// @dev Official Safe singletons on the target chain (`.safeSingletons`); a Safe owner must run one of them. Empty
        /// = the singleton is not checked (it must still have code).
        address[] safeSingletons;
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
        c.allowEoaOwner = vm.envOr("ALLOW_EOA_OWNER", false);
        if (vm.keyExistsJson(json, ".safeSingletons")) {
            c.safeSingletons = vm.parseJsonAddressArray(json, ".safeSingletons");
        }

        c.roles.owner = _addr(json, ".roles.owner");
        c.roles.safe = _addr(json, ".roles.safe");
        if (vm.keyExistsJson(json, ".roles.timelockOwner")) {
            address tlOwner = vm.parseJsonAddress(json, ".roles.timelockOwner");
            require(
                c.roles.safe == address(0) || c.roles.safe == tlOwner,
                "SystemConfig: roles.safe and roles.timelockOwner disagree (set one)"
            );
            c.roles.safe = tlOwner;
        }
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
            string memory problem = ownerSafeProblem(r.owner, c.safeSingletons, c.allowEoaOwner);
            require(bytes(problem).length == 0, string.concat("SystemConfig: testnet owner refused: ", problem));
        } else {
            require(c.usdg != address(0) && c.usdg.code.length != 0, "SystemConfig: usdg has no code");
            require(c.swapRouter != address(0) && c.swapRouter.code.length != 0, "SystemConfig: swapRouter has no code");
            for (uint256 i; i < c.stocks.length; ++i) {
                StockCfg memory s = c.stocks[i];
                require(s.stock.code.length != 0 && s.feed.code.length != 0, "SystemConfig: stock or feed has no code");
                require(s.uniPool.code.length != 0, "SystemConfig: TWAP pool has no code");
            }
        }
        if (c.profile != PROFILE_TESTNET && r.safe != address(0)) {
            // Fork: unset = the script deploys a ForkSafe. Mainnet: required (below).
            string memory problem = timelockOwnerProblem(r.safe, c.profile, c.allowEoaOwner);
            require(bytes(problem).length == 0, string.concat("SystemConfig: timelock owner refused: ", problem));
            require(
                r.safe != r.keeper && r.safe != r.hedger && r.safe != r.volSigner,
                "SystemConfig: the timelock owner must not be a bot key"
            );
            // The guardian pauses instantly; the owner acts only through the 48h timelock. One key must not do both.
            require(r.safe != r.guardian, "SystemConfig: the timelock owner must not be the guardian");
        }
        if (c.profile == PROFILE_MAINNET) {
            require(r.safe != address(0), "SystemConfig: mainnet needs roles.timelockOwner (or roles.safe)");
            require(
                r.keepersPot != address(0) && r.hedgerPot != address(0), "SystemConfig: mainnet fee pots are required"
            );
            require(c.uniswapFactory != address(0), "SystemConfig: mainnet needs the Uniswap v3 factory");
        }
    }

    address internal constant SAFE_MODULES_SENTINEL = address(0x1);
    /// @dev keccak256("guard_manager.guard.address"), Safe's guard storage slot.
    uint256 internal constant SAFE_GUARD_SLOT = 0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8; // not-a-key

    /// @notice Why `owner` cannot administer the testnet deployment ("" = it can). A real Safe check, not a code-size check
    /// (crypto-audit-lessons): an EIP-7702 delegated EOA is refused although it has code; a contract owner must answer as a
    /// Safe with threshold >= 2, at least `threshold` owners, no module (a module bypasses the threshold), no guard, and a
    /// singleton from `singletons` when that list is given. A plain EOA passes only with `allowEoa` (ALLOW_EOA_OWNER=1).
    function ownerSafeProblem(address owner, address[] memory singletons, bool allowEoa) internal view returns (string memory) {
        if (isDelegatedEoa(owner)) return "OWNER_IS_DELEGATED_EOA";
        if (owner.code.length == 0) return allowEoa ? "" : "OWNER_IS_EOA (deploy the owner Safe first, or ALLOW_EOA_OWNER=1)";
        uint256 threshold = _safeThreshold(owner);
        if (threshold < 2) return "OWNER_SAFE_THRESHOLD_BELOW_2";
        if (_safeOwners(owner) < threshold) return "OWNER_SAFE_OWNERS_BELOW_THRESHOLD";
        (bool ok, bytes memory m) =
            owner.staticcall(abi.encodeWithSignature("getModulesPaginated(address,uint256)", SAFE_MODULES_SENTINEL, 10));
        if (!ok || m.length < 64) return "OWNER_SAFE_MODULES_UNREADABLE";
        (address[] memory modules,) = abi.decode(m, (address[], address));
        if (modules.length != 0) return "OWNER_SAFE_HAS_MODULE";
        if (_safeSlot(owner, SAFE_GUARD_SLOT) != 0) return "OWNER_SAFE_HAS_GUARD";
        address singleton = address(uint160(_safeSlot(owner, 0)));
        if (singleton.code.length == 0) return "OWNER_SAFE_SINGLETON_NO_CODE";
        if (singletons.length != 0) {
            bool known;
            for (uint256 i; i < singletons.length; ++i) {
                if (singletons[i] == singleton) known = true;
            }
            if (!known) return "OWNER_SAFE_UNKNOWN_SINGLETON";
        }
        return "";
    }

    /// @notice Why `owner` cannot run the 48h timelock on fork or mainnet ("" = it can). An EIP-7702 delegated EOA is
    /// always refused (it has code, and its delegate could answer like a Safe). A plain EOA (no code) passes only with
    /// `allowEoa` (ALLOW_EOA_OWNER=1, owner decision 2026-10-28). A contract must be a Safe of at least 3-of-5 on mainnet;
    /// on fork any contract (the ForkSafe stand-in) passes.
    function timelockOwnerProblem(address owner, uint8 profile, bool allowEoa) internal view returns (string memory) {
        if (isDelegatedEoa(owner)) return "OWNER_IS_DELEGATED_EOA";
        if (owner.code.length == 0) {
            return allowEoa ? "" : "OWNER_IS_EOA (deploy the owner Safe first, or ALLOW_EOA_OWNER=1)";
        }
        if (
            profile == PROFILE_MAINNET
                && (_safeThreshold(owner) < MAINNET_SAFE_MIN_THRESHOLD || _safeOwners(owner) < MAINNET_SAFE_MIN_OWNERS)
        ) return "OWNER_SAFE_BELOW_3_OF_5";
        return "";
    }

    /// @dev EIP-7702 delegation designator: exactly 0xef0100 followed by the 20-byte delegate (23 bytes).
    function isDelegatedEoa(address a) internal view returns (bool) {
        bytes memory code = a.code;
        return code.length == 23 && code[0] == 0xef && code[1] == 0x01 && code[2] == 0x00;
    }

    /// @dev One storage word of a Safe through its StorageAccessible `getStorageAt` (0 when unreadable).
    function _safeSlot(address safe, uint256 slot) internal view returns (uint256 v) {
        (bool ok, bytes memory d) = safe.staticcall(abi.encodeWithSignature("getStorageAt(uint256,uint256)", slot, 1));
        if (!ok || d.length < 96) return 0;
        bytes memory word = abi.decode(d, (bytes));
        if (word.length == 32) v = uint256(bytes32(word));
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
