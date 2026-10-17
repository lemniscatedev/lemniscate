// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20Upgradeable} from "@openzeppelin/contracts-upgradeable/token/ERC20/ERC20Upgradeable.sol";
import {IOptionToken} from "./interfaces/IOptionToken.sol";
import {IOptionEngine} from "./interfaces/IOptionEngine.sol";

/// @dev The engine's transfer hook (LemniscateEngine.onTokenTransfer, review F01).
interface IOptionTokenHolds {
    function onTokenTransfer(bytes32 id, address from, address to) external;
}

/// @title OptionToken
/// @notice The ERC-20 of one option series (e.g. "eNVDA-C-110-W"), deployed as an EIP-1167 clone by the
/// SeriesRegistry. 18 decimals. Holder units = balance * norm / 1e18, where the series `norm` lives in the registry and
/// only falls as funding accrues: holders pay funding by holding fewer units, never by a transfer or a bill.
/// @dev Every balance change (mint, burn, transfer, transferFrom) first calls `engine.accrue(seriesId)`, so the norm is
/// current before any balance moves; if accrue reverts, the balance change reverts. Only the engine mints and burns.
/// The engine's accrue must therefore be callable from inside its own mint/burn (no reentrancy lock on accrue) and must
/// be a cheap no-op when the series was already accrued in this block.
contract OptionToken is ERC20Upgradeable, IOptionToken {
    error NotEngine();
    error InvalidEngine();

    address public engine;
    bytes32 public seriesId;

    constructor() {
        // The implementation itself is never a live token.
        _disableInitializers();
    }

    /// @notice One-time setup of a fresh clone. The factory calls this in the same transaction as the clone deployment.
    function initialize(address engine_, bytes32 seriesId_, string calldata name_, string calldata symbol_)
        external
        initializer
    {
        if (engine_ == address(0)) revert InvalidEngine();
        __ERC20_init(name_, symbol_);
        engine = engine_;
        seriesId = seriesId_;
    }

    /// @notice Mints to a buyer. Only the engine.
    function mint(address to, uint256 amount) external onlyEngine {
        _mint(to, amount);
    }

    /// @notice Burns from a seller during that seller's own sell. Only the engine.
    function burn(address from, uint256 amount) external onlyEngine {
        _burn(from, amount);
    }

    /// @dev Accrue the series before any balance changes. A holder-to-holder transfer also hands the sender's open
    /// minimum hold to the receiver (review F01). That call cannot be starved of gas to skip it: it needs far less than
    /// the 1/64 of the forwarded gas this function keeps for the transfer itself.
    function _update(address from, address to, uint256 value) internal override {
        IOptionEngine(engine).accrue(seriesId);
        if (from != address(0) && to != address(0)) {
            try IOptionTokenHolds(engine).onTokenTransfer(seriesId, from, to) {} catch {}
        }
        super._update(from, to, value);
    }

    modifier onlyEngine() {
        if (msg.sender != engine) revert NotEngine();
        _;
    }
}
