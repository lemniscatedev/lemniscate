// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SystemFixture} from "./utils/SystemFixture.sol";
import {ListMarkets} from "../script/ListMarkets.s.sol";
import {MockFeed} from "./mocks/MockFeed.sol";
import {MockStockToken} from "./mocks/MockStockToken.sol";
import {MarketConfig} from "../src/libs/LemniscateTypes.sol";
import {OptionToken} from "../src/OptionToken.sol";
import {IHedgeAdapter} from "../src/interfaces/IHedgeAdapter.sol";

contract ListingFeed is MockFeed {
    constructor() MockFeed(8, 631_97500000) {}
    function description() external pure returns (string memory) { return "RHAMD / USD"; }
}

contract ListMarketsTest is SystemFixture {
    ListMarkets internal script;
    ListingFeed internal feed;
    MockStockToken internal stock;

    function setUp() public {
        _deploySystem(); script = new ListMarkets(); feed = new ListingFeed(); stock = new MockStockToken();
    }

    function input() internal view returns (ListMarkets.Input memory) {
        return ListMarkets.Input("AMD", address(stock), address(feed), 3000, 5500, 5);
    }

    function testCopiesEveryRiskFieldAndSetsCarryAndScale() public view {
        (MarketConfig memory actual, int64 base) = script.buildConfig(engine, 0, input());
        MarketConfig memory expected = engine.getConfig(0);
        expected.stock = stock; expected.feed = feed; expected.token = OptionToken(address(0));
        expected.scale = 10000; expected.kind = 0; expected.feed2 = address(0);
        expected.offHoursCarryWad = 994520547945205; expected.skewCarryWad = 5e14;
        expected.minCarryWad = 0; expected.maxCarryWad = 5e15;
        expected.baseCarryMinWad = 248630136986301; expected.baseCarryMaxWad = 3978082191780820;
        assertEq(base, 994520547945205);
        assertEq(abi.encode(actual), abi.encode(expected));
        assertEq(actual.offHoursBuyMaxAge, 6 hours);
    }

    function testTokenPredictionRouteAndExactCalldataOutput() public {
        bytes32 slot = 0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc; // not-a-key
        address factory = vm.computeCreateAddress(address(uint160(uint256(vm.load(address(engine), slot)))), 1);
        uint64 nonce = vm.getNonce(factory);
        address predicted = vm.computeCreateAddress(factory, nonce);
        vm.setEnv("ENGINE", vm.toString(address(engine))); vm.setEnv("VAULT", vm.toString(address(vault)));
        vm.setEnv("ADMIN", vm.toString(address(this))); vm.setEnv("HEDGE_ADAPTER", vm.toString(address(adapters[0])));
        vm.setEnv("LISTING_OUTPUT", "out/listing-test.json");
        string memory json = string.concat('{"expectedMarketCount":2,"factory":"', vm.toString(factory), '","factoryNonce":', vm.toString(nonce),
            ',"markets":[{"symbol":"AMD","stock":"', vm.toString(address(stock)), '","feed":"', vm.toString(address(feed)),
            '","poolFee":3000,"sigmaBps":5500,"skewCarryBps":5}]}');
        script.run(json);
        assertEq(engine.marketCount(), 3); assertEq(address(engine.getConfig(2).token), predicted);
        assertEq(engine.marketIdOf(predicted), 2);
        (IHedgeAdapter adapter, uint24 fee) = vault.routeForMarket(2);
        assertEq(address(adapter), address(adapters[0])); assertEq(fee, 3000);
        string memory output = vm.readFile("out/listing-test.json");
        assertEq(vm.parseJsonBytes(output, ".markets[0].expectedConfig"), abi.encode(engine.getConfig(2)));
        assertEq(vm.parseJsonAddress(output, ".markets[0].token"), predicted);
        assertEq(vm.parseJsonAddress(output, ".calls[1].to"), address(vault));
        assertEq(vm.parseJsonBytes(output, ".calls[1].data"), abi.encodeCall(vault.setHedgeRoute, (2, adapter, fee)));
        vm.expectRevert("Listing: market count changed"); script.run(json);
    }

    function testRefusesAlreadyListedStock() public {
        ListMarkets.Input memory value = input(); value.stock = address(stocks[0]);
        vm.expectRevert("Listing: stock already listed"); script.buildConfig(engine, 0, value);
    }

    function testRefusesBadFeedAndInputs() public {
        feed.setUpdatedAt(0);
        vm.expectRevert("Listing: invalid feed"); script.buildConfig(engine, 0, input());
        feed.setUpdatedAt(block.timestamp); feed.setDecimals(18);
        vm.expectRevert("Listing: invalid feed"); script.buildConfig(engine, 0, input());
        feed.setDecimals(8); feed.setAnswer(0);
        vm.expectRevert("Listing: invalid feed"); script.buildConfig(engine, 0, input());
        feed.setAnswer(200e8);
        ListMarkets.Input memory value = input(); value.symbol = "WRONG";
        vm.expectRevert("Listing: feed symbol mismatch"); script.buildConfig(engine, 0, value);
        value = input(); value.sigmaBps = 0;
        vm.expectRevert("Listing: base carry outside bounds"); script.buildConfig(engine, 0, value);
        value = input(); value.poolFee = 0;
        vm.expectRevert("Listing: unsupported fee"); script.buildConfig(engine, 0, value);
    }
}
