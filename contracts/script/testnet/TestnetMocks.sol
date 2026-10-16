// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IStockToken} from "../../src/interfaces/IStockToken.sol";
import {ISwapRouter02} from "../../src/interfaces/ISwapRouter02.sol";

/// @notice Testnet-only stand-ins for the mainnet tokens, feeds and swap venue (the testnet has no Stock Tokens, no
/// mintable USDG and no Uniswap v3; chain-facts R10). Never deployed by the fork or mainnet profiles.

/// @notice 6-decimal test dollar with a rate-limited public faucet and an owner mint.
contract TestnetUSDG is ERC20, ERC20Permit {
    uint256 public constant FAUCET_AMOUNT = 10_000e6;
    uint256 public constant FAUCET_COOLDOWN = 1 hours;
    address public immutable owner;
    mapping(address => uint256) public lastDrip;

    error NotOwner();
    error FaucetCooldown(uint256 nextAt);

    constructor(address owner_) ERC20("Test Global Dollar", "tUSDG") ERC20Permit("Test Global Dollar") {
        owner = owner_;
    }

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (msg.sender != owner) revert NotOwner();
        _mint(to, amount);
    }

    function faucet() external {
        uint256 next = lastDrip[msg.sender] + FAUCET_COOLDOWN;
        if (lastDrip[msg.sender] != 0 && block.timestamp < next) revert FaucetCooldown(next);
        lastDrip[msg.sender] = block.timestamp;
        _mint(msg.sender, FAUCET_AMOUNT);
    }
}

/// @notice 18-decimal test Stock Token with the multiplier surface PriceGuard reads; the owner can stage a split.
contract TestnetStockToken is ERC20, IStockToken {
    address public immutable owner;
    bool public override oraclePaused;
    bool public override paused;
    uint256 private _ui = 1e18;
    uint256 private _pending = 1e18;
    uint256 public override effectiveAt;

    error NotOwner();

    constructor(string memory name_, string memory symbol_, address owner_) ERC20(name_, symbol_) {
        owner = owner_;
    }

    modifier onlyOwner() {
        if (msg.sender != owner) revert NotOwner();
        _;
    }

    function uiMultiplier() external view override returns (uint256) {
        return effectiveAt != 0 && block.timestamp >= effectiveAt ? _pending : _ui;
    }

    function newUIMultiplier() external view override returns (uint256) {
        return _pending;
    }

    function mint(address to, uint256 amount) external onlyOwner {
        _mint(to, amount);
    }

    /// @notice Stages a multiplier change (a split or dividend) effective at `effectiveAt_`.
    function scheduleMultiplier(uint256 pending, uint256 effectiveAt_) external onlyOwner {
        if (effectiveAt != 0 && block.timestamp >= effectiveAt) _ui = _pending;
        uint256 previous = _ui;
        _pending = pending;
        effectiveAt = effectiveAt_;
        emit UIMultiplierUpdated(previous, pending, effectiveAt_);
    }

    function setPaused(bool paused_, bool oraclePaused_) external onlyOwner {
        paused = paused_;
        oraclePaused = oraclePaused_;
    }
}

/// @notice Chainlink-style 8-decimal feed. The `updater` (the keeper's mirror job) copies the mainnet answer in.
contract TestnetFeed {
    uint8 public constant decimals = 8;
    address public immutable owner;
    address public updater;
    string public description;
    uint80 public roundId;
    int256 public answer;
    uint256 public updatedAt;

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);
    event UpdaterSet(address updater);

    error NotUpdater();
    error NotOwner();
    error BadAnswer();

    constructor(string memory description_, address owner_, address updater_, int256 answer_) {
        if (answer_ <= 0) revert BadAnswer();
        description = description_;
        owner = owner_;
        updater = updater_;
        answer = answer_;
        updatedAt = block.timestamp;
        roundId = 1;
        emit AnswerUpdated(answer_, 1, block.timestamp);
    }

    function setUpdater(address updater_) external {
        if (msg.sender != owner) revert NotOwner();
        updater = updater_;
        emit UpdaterSet(updater_);
    }

    /// @notice New round at the current block time (owner or updater).
    function push(int256 answer_) external {
        if (msg.sender != updater && msg.sender != owner) revert NotUpdater();
        if (answer_ <= 0) revert BadAnswer();
        answer = answer_;
        updatedAt = block.timestamp;
        ++roundId;
        emit AnswerUpdated(answer_, roundId, block.timestamp);
    }

    function aggregator() external view returns (address) {
        return address(this);
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}

interface ITestnetFeed {
    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80);
}

/// @notice Swap venue for the pool's hedges on testnet: fills at the mock feed price minus the fee tier, from
/// inventory the owner mints into it. Same call surface as Uniswap's SwapRouter02 `exactInputSingle`.
contract TestnetSwapRouter is ISwapRouter02 {
    using SafeERC20 for IERC20;

    address public immutable owner;
    address public immutable usdg;
    mapping(address stock => address feed) public feedOf;

    error NotOwner();
    error UnknownPair();
    error InsufficientOutput();

    constructor(address owner_, address usdg_) {
        owner = owner_;
        usdg = usdg_;
    }

    function setFeed(address stock, address feed) external {
        if (msg.sender != owner) revert NotOwner();
        feedOf[stock] = feed;
    }

    function exactInputSingle(ExactInputSingleParams calldata p) external payable override returns (uint256 amountOut) {
        bool buyStock = p.tokenIn == usdg;
        address stock = buyStock ? p.tokenOut : p.tokenIn;
        address feed = feedOf[stock];
        if (feed == address(0) || (p.tokenIn != usdg && p.tokenOut != usdg)) revert UnknownPair();
        (, int256 answer,,,) = ITestnetFeed(feed).latestRoundData();
        uint256 px = uint256(answer) * 1e10; // WAD USDG per whole stock token
        uint256 net = p.amountIn * (1e6 - p.fee) / 1e6;
        // USDG 6 dp <-> stock 18 dp: stock = usdg * 1e12 * 1e18 / px; usdg = stock * px / 1e18 / 1e12
        amountOut = buyStock ? net * 1e30 / px : net * px / 1e30;
        if (amountOut < p.amountOutMinimum) revert InsufficientOutput();
        IERC20(p.tokenIn).safeTransferFrom(msg.sender, address(this), p.amountIn);
        IERC20(p.tokenOut).safeTransfer(p.recipient, amountOut);
    }
}
