// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {MarketHours} from "../src/MarketHours.sol";
import {IMarketHours} from "../src/interfaces/IMarketHours.sol";
import {Session} from "../src/libs/LemniscateTypes.sol";

contract MarketHoursV2 is MarketHours {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract MarketHoursTest is Test {
    address private admin = makeAddr("admin");
    address private keeper = makeAddr("keeper");
    address private stranger = makeAddr("stranger");
    MarketHours private marketHours;

    function setUp() public {
        MarketHours implementation = new MarketHours();
        bytes memory initData = abi.encodeCall(MarketHours.initialize, (admin, keeper));
        ERC1967Proxy proxy = new ERC1967Proxy(address(implementation), initData);
        marketHours = MarketHours(address(proxy));
    }

    function testIsOpenUsesInclusiveOpenAndExclusiveClose() public {
        Session[] memory calendar = new Session[](1);
        calendar[0] = Session({open: uint64(block.timestamp + 10), close: uint64(block.timestamp + 20)});
        _setSessions(calendar);

        assertFalse(marketHours.isOpen(block.timestamp + 9));
        assertTrue(marketHours.isOpen(block.timestamp + 10));
        assertTrue(marketHours.isOpen(block.timestamp + 19));
        assertFalse(marketHours.isOpen(block.timestamp + 20));
    }

    function testCurrentSessionReportsOpenAndNextOpen() public {
        Session[] memory calendar = new Session[](2);
        calendar[0] = Session({open: uint64(block.timestamp), close: uint64(block.timestamp + 100)});
        calendar[1] = Session({open: uint64(block.timestamp + 200), close: uint64(block.timestamp + 300)});
        _setSessions(calendar);

        (bool openNow, uint64 open, uint64 close, uint64 nextOpen) = marketHours.currentSession();
        assertTrue(openNow);
        assertEq(open, block.timestamp);
        assertEq(close, block.timestamp + 100);
        assertEq(nextOpen, block.timestamp + 200);

        vm.warp(block.timestamp + 100);
        (openNow, open, close, nextOpen) = marketHours.currentSession();
        assertFalse(openNow);
        assertEq(open, 0);
        assertEq(close, 0);
        assertEq(nextOpen, calendar[1].open);
    }

    function testOnlyKeeperCanReplaceSessions() public {
        Session[] memory calendar = new Session[](0);
        vm.expectRevert(
            abi.encodeWithSelector(
                IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, marketHours.KEEPER_ROLE()
            )
        );
        vm.prank(stranger);
        marketHours.setSessions(calendar);
    }

    function testRejectsInvalidAndUnsortedSessions() public {
        Session[] memory calendar = new Session[](1);
        calendar[0] = Session({open: uint64(block.timestamp + 10), close: uint64(block.timestamp + 10)});
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.InvalidSession.selector, 0));
        vm.prank(keeper);
        marketHours.setSessions(calendar);

        calendar = new Session[](2);
        calendar[0] = Session({open: uint64(block.timestamp + 30), close: uint64(block.timestamp + 40)});
        calendar[1] = Session({open: uint64(block.timestamp + 10), close: uint64(block.timestamp + 20)});
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.SessionsUnsorted.selector, 1));
        vm.prank(keeper);
        marketHours.setSessions(calendar);
    }

    function testRejectsOverlappingSessions() public {
        Session[] memory calendar = new Session[](2);
        calendar[0] = Session({open: uint64(block.timestamp + 10), close: uint64(block.timestamp + 40)});
        calendar[1] = Session({open: uint64(block.timestamp + 30), close: uint64(block.timestamp + 50)});
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.SessionsOverlap.selector, 1));
        vm.prank(keeper);
        marketHours.setSessions(calendar);
    }

    function testRejectsSessionsLongerThanFiveDaysAndOneHour() public {
        Session[] memory calendar = new Session[](1);
        calendar[0] =
            Session({open: uint64(block.timestamp + 10), close: uint64(block.timestamp + 5 days + 1 hours + 11)});
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.SessionTooLong.selector, 0));
        vm.prank(keeper);
        marketHours.setSessions(calendar);
    }

    function testRejectsMoreThanThirtyTwoSessions() public {
        Session[] memory calendar = new Session[](33);
        for (uint256 i; i < calendar.length; ++i) {
            uint64 open = uint64(block.timestamp + 10 + i * 2);
            calendar[i] = Session({open: open, close: open + 1});
        }
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.TooManySessions.selector, 33));
        vm.prank(keeper);
        marketHours.setSessions(calendar);
    }

    function testRejectsSessionsMoreThanThirtyDaysAhead() public {
        Session[] memory calendar = new Session[](1);
        calendar[0] = Session({open: uint64(block.timestamp + 31 days), close: uint64(block.timestamp + 31 days + 1)});
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.SessionTooFar.selector, 0));
        vm.prank(keeper);
        marketHours.setSessions(calendar);
    }

    function testOnlyAdminCanUpgrade() public {
        MarketHoursV2 nextImplementation = new MarketHoursV2();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, stranger, bytes32(0))
        );
        vm.prank(stranger);
        UUPSUpgradeable(address(marketHours)).upgradeToAndCall(address(nextImplementation), "");

        vm.prank(admin);
        UUPSUpgradeable(address(marketHours)).upgradeToAndCall(address(nextImplementation), "");
        assertEq(MarketHoursV2(address(marketHours)).version(), 2);
    }

    function _setSessions(Session[] memory calendar) private {
        vm.prank(keeper);
        marketHours.setSessions(calendar);
    }
}
