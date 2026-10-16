// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPool} from "../../src/interfaces/IPool.sol";
import {IPriceGuard} from "../../src/interfaces/IPriceGuard.sol";
import {IVolOracle} from "../../src/interfaces/IVolOracle.sol";
import {IOptionEngine} from "../../src/interfaces/IOptionEngine.sol";
import {PriceReading, SessionKind, Speed, VolReading} from "../../src/libs/OptionTypes.sol";

/// @dev 6-decimal USDG with an issuer pause and a per-address block list (decision 12), plus permit.
contract MockPausableUSDG is ERC20, ERC20Permit {
    bool public paused;
    mapping(address => bool) public blocked;

    error IssuerPaused();
    error IssuerBlocked(address who);

    constructor() ERC20("Global Dollar", "USDG") ERC20Permit("Global Dollar") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function setPaused(bool p) external {
        paused = p;
    }

    function setBlocked(address who, bool b) external {
        blocked[who] = b;
    }

    function _update(address from, address to, uint256 value) internal override {
        if (paused) revert IssuerPaused();
        if (blocked[from]) revert IssuerBlocked(from);
        if (blocked[to]) revert IssuerBlocked(to);
        super._update(from, to, value);
    }
}

/// @dev PriceGuard stand-in: a settable reading per stock. `read` adds the TWAP pause, `readLite` does not.
contract MockEnginePriceGuard is IPriceGuard {
    struct Px {
        uint256 s;
        SessionKind session;
        bool fresh;
        bool buysPaused;
        bool twapPaused;
    }

    mapping(address => Px) public px;
    /// @dev Gas each read burns, to model the real PriceGuard (~57k per read on a mainnet fork with feeds and tokens).
    uint256 public readGas;

    function setReadGas(uint256 g) external {
        readGas = g;
    }

    function _burn() internal view {
        uint256 stop = gasleft() > readGas ? gasleft() - readGas : 0;
        uint256 x;
        while (gasleft() > stop) x = uint256(keccak256(abi.encode(x)));
    }

    function set(address stock, uint256 s, SessionKind session, bool fresh) external {
        Px storage p = px[stock];
        p.s = s;
        p.session = session;
        p.fresh = fresh;
    }

    function setS(address stock, uint256 s) external {
        px[stock].s = s;
    }

    function setSession(address stock, SessionKind session) external {
        px[stock].session = session;
    }

    function setPauses(address stock, bool buysPaused, bool twapPaused) external {
        px[stock].buysPaused = buysPaused;
        px[stock].twapPaused = twapPaused;
    }

    function read(address stock) public view returns (PriceReading memory r) {
        _burn();
        Px memory p = px[stock];
        r = PriceReading({s: p.s, session: p.session, fresh: p.fresh, buysPaused: p.buysPaused || p.twapPaused, updatedAt: block.timestamp});
    }

    function readLite(address stock) external view returns (PriceReading memory r) {
        _burn();
        Px memory p = px[stock];
        r = PriceReading({s: p.s, session: p.session, fresh: p.fresh, buysPaused: p.buysPaused, updatedAt: block.timestamp});
    }

    function lastGoodPrice(address stock) external view returns (uint256 s, uint256 at) {
        return (px[stock].s, block.timestamp);
    }

    function setStock(address, StockConfig calldata) external pure {}
    function setBuysPaused(address, bool) external pure {}

    function config(address) external pure returns (StockConfig memory c) {
        return c;
    }

    function poke(address stock) external view returns (PriceReading memory) {
        return read(stock);
    }

    function setTwapSource(address, address, uint32, uint16) external pure {}

    function twapCheck(address stock) external view returns (uint256, bool) {
        return (px[stock].s, !px[stock].twapPaused);
    }
}

/// @dev VolOracle stand-in: settable readings per stock and speed.
contract MockEngineVol is IVolOracle {
    mapping(address => mapping(Speed => VolReading)) internal _v;

    function set(address stock, Speed speed, uint64 sigmaBps, uint64 skewK, uint64 validUntil) external {
        VolReading storage v = _v[stock][speed];
        v.sigmaBps = sigmaBps;
        v.skewK = skewK;
        v.validUntil = validUntil;
    }

    function setBlock(address stock, Speed speed, uint64 from, uint64 to) external {
        _v[stock][speed].buyBlockFrom = from;
        _v[stock][speed].buyBlockTo = to;
    }

    function read(address stock, Speed speed) external view returns (VolReading memory r) {
        r = _v[stock][speed];
        r.stale = block.timestamp > r.validUntil;
    }

    function post(Post calldata, bytes calldata) external pure {}
    function setSigner(address) external pure {}
    function setFloor(address, uint64) external pure {}

    function signer() external pure returns (address) {
        return address(0);
    }
}

/// @dev Writer Pool stand-in. NAV = USDG cash + navAdjust - liability; shares settable (drawdown tests). Pays sells
/// from its USDG (so an issuer pause reverts the payout), can be told to fail payouts or funding reports.
contract MockEnginePool is IPool {
    IERC20 public immutable usdg;
    address public engine;
    int256 public navAdjustWad;
    uint256 public totalSupply = 1_000_000e6;
    bool public failPay;
    bool public failFunding;
    bool public stale;

    uint256 public saleIn;
    uint256 public saleSpread;
    uint256 public paidOut;
    uint256 public paidSpread;
    uint256 public fundingUsdg;
    uint256 public fundingCalls;

    error PayFailed();
    error FundingFailed();

    constructor(IERC20 usdg_) {
        usdg = usdg_;
    }

    function setEngine(address e) external {
        engine = e;
    }

    function setNavAdjust(int256 a) external {
        navAdjustWad = a;
    }

    function setShares(uint256 s) external {
        totalSupply = s;
    }

    function setFailPay(bool f) external {
        failPay = f;
    }

    function setFailFunding(bool f) external {
        failFunding = f;
    }

    function setHedgeStale(bool s) external {
        stale = s;
    }

    /// @dev Gas navFor burns, to model the real WriterPool (cash + hedges valued through PriceGuard: ~170k on a fork).
    uint256 public navGas;

    function setNavGas(uint256 g) external {
        navGas = g;
    }

    function onSale(bytes32, uint256 usdgIn, uint256 spreadUsdg) external {
        if (msg.sender != engine) revert NotEngine();
        saleIn += usdgIn;
        saleSpread += spreadUsdg;
    }

    function pay(address to, uint256 usdgOut, uint256 spreadUsdg) external {
        if (msg.sender != engine) revert NotEngine();
        if (failPay) revert PayFailed();
        if (usdgOut != 0) require(usdg.transfer(to, usdgOut), "transfer");
        paidOut += usdgOut;
        paidSpread += spreadUsdg;
    }

    function onFunding(bytes32, uint256 amount) external {
        if (msg.sender != engine) revert NotEngine();
        if (failFunding) revert FundingFailed();
        fundingUsdg += amount;
        ++fundingCalls;
    }

    function hedgeStale() external view returns (bool) {
        return stale;
    }

    function nav() external view returns (int256) {
        return navFor(IOptionEngine(engine).totalLiability());
    }

    function navFor(uint256 liabilityWad) public view returns (int256) {
        uint256 stop = gasleft() > navGas ? gasleft() - navGas : 0;
        uint256 x;
        while (gasleft() > stop) x = uint256(keccak256(abi.encode(x)));
        return int256(usdg.balanceOf(address(this)) * 1e12) + navAdjustWad - int256(liabilityWad);
    }

    function navPerShare() external view returns (uint256) {
        int256 n = this.nav();
        return n <= 0 ? 0 : uint256(n) * 1e18 / totalSupply;
    }

    function postHedgeEquity(uint256, uint64, bytes32) external pure {}

    function hedgeEquity() external pure returns (uint256, uint64) {
        return (0, 0);
    }

    function deposit(uint256, address) external pure returns (uint256) {
        return 0;
    }

    function requestWithdraw(uint256) external pure returns (uint256) {
        return 0;
    }

    function claim(uint256) external pure returns (uint256) {
        return 0;
    }

    function publicDeposits() external pure returns (bool) {
        return false;
    }

    function maxOutstandingBps() external pure returns (uint16) {
        return 3500;
    }

    function maxPerNameBps() external pure returns (uint16) {
        return 800;
    }

    function capsFor(uint256) external pure returns (uint256, uint256) {
        return (0, 0);
    }

    function rebalance(address, uint256, uint256) external pure returns (int256) {
        return 0;
    }

    function hedgeUnits(address stock) external view returns (uint256) {
        return IERC20(stock).balanceOf(address(this));
    }
}
