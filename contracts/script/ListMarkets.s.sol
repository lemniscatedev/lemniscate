// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {LemniscateScript} from "./lib/LemniscateScript.sol";
import {LemniscateEngine} from "../src/LemniscateEngine.sol";
import {WriterPool} from "../src/WriterPool.sol";
import {OptionToken} from "../src/OptionToken.sol";
import {IStockToken} from "../src/interfaces/IStockToken.sol";
import {IAggregatorV3} from "../src/interfaces/IAggregatorV3.sol";
import {IHedgeAdapter} from "../src/interfaces/IHedgeAdapter.sol";
import {MarketConfig} from "../src/libs/LemniscateTypes.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

interface IListingFeedDescription {
    function description() external view returns (string memory);
}

/// @notice Constructs exact listing calldata and checks it in Forge's local simulation. Never broadcasts.
contract ListMarkets is LemniscateScript {
    int64 internal constant MAX_CARRY_WAD = 5e15;
    struct Input { string symbol; address stock; address feed; uint24 poolFee; uint16 sigmaBps; uint16 skewCarryBps; }

    function run() external { run(vm.envString("LISTING_JSON")); }

    function run(string memory json) public {
        Deployment memory d = loadDeployment();
        LemniscateEngine engine = LemniscateEngine(d.engine);
        WriterPool vault = WriterPool(d.vault);
        require(d.admin != address(0) && engine.hasRole(DEFAULT_ADMIN_ROLE, d.admin)
            && vault.hasRole(DEFAULT_ADMIN_ROLE, d.admin), "Listing: admin required on both contracts");
        require(d.hedgeAdapter.code.length != 0, "Listing: missing adapter");
        uint256 referenceId = vm.keyExistsJson(json, ".referenceMarketId") ? vm.parseJsonUint(json, ".referenceMarketId") : 0;
        require(referenceId < engine.marketCount(), "Listing: invalid reference id");
        uint8 start = engine.marketCount();
        uint256 expectedCount = vm.parseJsonUint(json, ".expectedMarketCount");
        require(start == expectedCount, "Listing: market count changed");
        // This implementation creates the token factory as its first constructor child.
        address implementation = address(uint160(uint256(vm.load(d.engine, IMPLEMENTATION_SLOT))));
        address factory = vm.computeCreateAddress(implementation, 1);
        require(factory == vm.parseJsonAddress(json, ".factory") && factory.code.length != 0, "Listing: verify factory");
        uint64 nonce = vm.getNonce(factory);
        require(nonce == vm.parseJsonUint(json, ".factoryNonce"), "Listing: factory nonce changed");
        string memory calls = "[";
        string memory markets = "[";
        uint256 count;
        while (vm.keyExistsJson(json, string.concat(".markets[", vm.toString(count), "]"))) ++count;
        require(count > 0 && uint256(start) + count <= 255, "Listing: invalid market count");
        for (uint256 i; i < count; ++i) {
            Input memory input = _input(json, i);
            (MarketConfig memory config, int64 baseCarry) = buildConfig(engine, uint8(referenceId), input);
            uint8 id = uint8(uint256(start) + i);
            address predicted = vm.computeCreateAddress(factory, nonce + uint64(i));
            bytes memory listing = abi.encodeCall(LemniscateEngine.listMarket,
                (config, string.concat(input.symbol, unicode"² Power Token"), string.concat(input.symbol, "2"), baseCarry));
            bytes memory route = abi.encodeCall(WriterPool.setHedgeRoute, (id, IHedgeAdapter(d.hedgeAdapter), input.poolFee));
            vm.prank(d.admin);
            require(engine.listMarket(config, string.concat(input.symbol, unicode"² Power Token"), string.concat(input.symbol, "2"), baseCarry) == id, "Listing: id mismatch");
            vm.prank(d.admin);
            vault.setHedgeRoute(id, IHedgeAdapter(d.hedgeAdapter), input.poolFee);
            config.token = OptionToken(predicted);
            require(keccak256(abi.encode(engine.getConfig(id))) == keccak256(abi.encode(config)), "Listing: predicted config mismatch");
            if (i != 0) { calls = string.concat(calls, ","); markets = string.concat(markets, ","); }
            calls = string.concat(calls, _call(input.symbol, d.engine, listing), ",", _call("route", d.vault, route));
            string memory key = string.concat("listing-market-", vm.toString(i));
            vm.serializeUint(key, "id", id); vm.serializeString(key, "symbol", input.symbol);
            vm.serializeAddress(key, "token", predicted); vm.serializeAddress(key, "stock", input.stock);
            vm.serializeAddress(key, "feed", input.feed); vm.serializeUint(key, "scale", config.scale);
            vm.serializeUint(key, "poolFee", input.poolFee);
            markets = string.concat(markets, vm.serializeBytes(key, "expectedConfig", abi.encode(config)));
        }
        string memory result = string.concat('{"chainId":', vm.toString(block.chainid), ',"factory":"', vm.toString(factory),
            '","factoryNonce":', vm.toString(nonce), ',"expectedMarketCount":', vm.toString(start),
            ',"engine":"', vm.toString(d.engine), '","vault":"', vm.toString(d.vault), '","adapter":"', vm.toString(d.hedgeAdapter),
            '","calls":', calls, '],"markets":', markets, "]}");
        vm.writeJson(result, vm.envOr("LISTING_OUTPUT", string("out/listing-calls.json")));
    }

    function buildConfig(LemniscateEngine engine, uint8 referenceId, Input memory input) public view returns (MarketConfig memory c, int64 baseCarry) {
        require(input.stock.code.length != 0 && input.feed.code.length != 0, "Listing: missing stock/feed code");
        require(bytes(input.symbol).length > 0 && bytes(input.symbol).length <= 16, "Listing: invalid symbol");
        require(input.poolFee == 500 || input.poolFee == 3000 || input.poolFee == 10000, "Listing: unsupported fee");
        require(_contains(bytes(IListingFeedDescription(input.feed).description()), bytes(input.symbol)), "Listing: feed symbol mismatch");
        for (uint8 id; id < engine.marketCount(); ++id) require(address(engine.getConfig(id).stock) != input.stock, "Listing: stock already listed");
        c = engine.getConfig(referenceId);
        c.stock = IStockToken(input.stock); c.feed = IAggregatorV3(input.feed); c.token = OptionToken(address(0));
        c.kind = 0; c.feed2 = address(0); c.scale = _scale(c.feed);
        uint256 base = Math.mulDiv(uint256(input.sigmaBps) * input.sigmaBps, 12e9, 365);
        require(base > 0 && base <= uint256(uint64(MAX_CARRY_WAD)), "Listing: base carry outside bounds");
        baseCarry = int64(int256(base));
        c.offHoursCarryWad = baseCarry; c.skewCarryWad = int64(uint64(input.skewCarryBps) * 1e14);
        c.minCarryWad = 0; c.maxCarryWad = MAX_CARRY_WAD;
        c.baseCarryMinWad = baseCarry / 4;
        c.baseCarryMaxWad = baseCarry * 4 > MAX_CARRY_WAD ? MAX_CARRY_WAD : baseCarry * 4;
    }

    function _input(string memory json, uint256 i) private view returns (Input memory input) {
        string memory p = string.concat(".markets[", vm.toString(i), "]");
        input.symbol = vm.parseJsonString(json, string.concat(p, ".symbol"));
        input.stock = vm.parseJsonAddress(json, string.concat(p, ".stock"));
        input.feed = vm.parseJsonAddress(json, string.concat(p, ".feed"));
        uint256 fee = vm.parseJsonUint(json, string.concat(p, ".poolFee"));
        uint256 sigma = vm.parseJsonUint(json, string.concat(p, ".sigmaBps"));
        uint256 skew = vm.parseJsonUint(json, string.concat(p, ".skewCarryBps"));
        require(fee <= type(uint24).max && sigma <= type(uint16).max && skew <= type(uint16).max, "Listing: integer overflow");
        input.poolFee = uint24(fee); input.sigmaBps = uint16(sigma); input.skewCarryBps = uint16(skew);
    }

    function _scale(IAggregatorV3 feed) private view returns (uint64) {
        (uint80 roundId, int256 answer,, uint256 updatedAt, uint80 answeredInRound) = feed.latestRoundData();
        require(feed.decimals() == 8 && roundId != 0 && answer > 0 && updatedAt != 0 && updatedAt <= block.timestamp && answeredInRound >= roundId, "Listing: invalid feed");
        uint256 spotWad = uint256(answer) * 1e10;
        uint256 index = Math.mulDiv(spotWad, spotWad, 1e18);
        uint256 scale = 1;
        while (index / scale > 100e18) { scale *= 10; require(scale <= type(uint64).max, "Listing: scale overflow"); }
        return uint64(scale);
    }

    function _contains(bytes memory subject, bytes memory needle) private pure returns (bool) {
        if (needle.length == 0 || needle.length > subject.length) return false;
        for (uint256 i; i <= subject.length - needle.length; ++i) {
            bool found = true;
            for (uint256 j; j < needle.length; ++j) if (subject[i+j] != needle[j]) { found = false; break; }
            if (found) return true;
        }
        return false;
    }

    function _call(string memory label, address to, bytes memory data) private returns (string memory) {
        string memory key = string.concat(label, vm.toString(to));
        vm.serializeString(key, "label", label); vm.serializeAddress(key, "to", to);
        vm.serializeString(key, "value", "0"); return vm.serializeBytes(key, "data", data);
    }
}
