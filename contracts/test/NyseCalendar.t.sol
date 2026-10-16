// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {IAccessControl} from "@openzeppelin/contracts/access/IAccessControl.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {MarketHours} from "../src/MarketHours.sol";
import {IMarketHours} from "../src/interfaces/IMarketHours.sol";
import {Holiday, NyseCalendar} from "../src/libs/NyseCalendar.sol";
import {SessionKind} from "../src/libs/OptionTypes.sol";
import {Session} from "../src/libs/LemniscateTypes.sol";

contract NyseCalendarHarness {
    function etOffset(uint256 ts) external pure returns (uint256) {
        return NyseCalendar.etOffset(ts);
    }

    function supported(uint256 ts) external pure returns (bool) {
        return NyseCalendar.supported(ts);
    }
}

contract NyseCalendarTest is Test {
    // US Eastern wall-clock instants (generated with Python zoneinfo, America/New_York).
    uint256 internal constant TUE_0359 = 1790063940; // Tue 2026-09-22 03:59 EDT
    uint256 internal constant TUE_0400 = 1790064000;
    uint256 internal constant TUE_0929 = 1790083740;
    uint256 internal constant TUE_0930 = 1790083800;
    uint256 internal constant TUE_1559 = 1790107140;
    uint256 internal constant TUE_1600 = 1790107200;
    uint256 internal constant TUE_1959 = 1790121540;
    uint256 internal constant TUE_2000 = 1790121600;
    uint256 internal constant FRI_1959 = 1790380740; // Fri 2026-09-25
    uint256 internal constant FRI_2000 = 1790380800;
    uint256 internal constant SAT_1200 = 1790438400;
    uint256 internal constant SUN_1959 = 1790553540; // Sun 2026-09-27
    uint256 internal constant SUN_2000 = 1790553600;
    uint256 internal constant MON_0359 = 1790582340;
    // DST starts Sun 2026-03-08 02:00 local.
    uint256 internal constant DST_SUN_1959 = 1773014340;
    uint256 internal constant DST_SUN_2000 = 1773014400;
    uint256 internal constant DST_MON_0929 = 1773062940;
    uint256 internal constant DST_MON_0930 = 1773063000;
    uint256 internal constant PRE_MON_0930 = 1772461800; // Mon 2026-03-02 09:30 EST
    // DST ends Sun 2026-11-01 02:00 local.
    uint256 internal constant STD_SUN_1959 = 1793581140;
    uint256 internal constant STD_SUN_2000 = 1793581200;
    uint256 internal constant STD_MON_0929 = 1793629740;
    uint256 internal constant STD_MON_0930 = 1793629800;
    // Thanksgiving 2026 (full) and the day after (13:00 early close).
    uint256 internal constant WED_BEFORE_TG_2000 = 1795654800;
    uint256 internal constant TG_1200 = 1795712400;
    uint256 internal constant TG_2000 = 1795741200;
    uint256 internal constant BF_1259 = 1795802340;
    uint256 internal constant BF_1300 = 1795802400;
    uint256 internal constant BF_1959 = 1795827540;
    uint256 internal constant Y2028_LAST_1000 = 1861714800;

    uint32 internal constant DAY_TG_2026 = 20783;
    uint32 internal constant DAY_BF_2026 = 20784;
    uint32 internal constant DAY_XMAS_2026 = 20812;
    uint32 internal constant DAY_JUL5_2027 = 21004;

    address internal admin = makeAddr("admin");
    address internal keeper = makeAddr("keeper");
    address internal stranger = makeAddr("stranger");
    MarketHours internal mh;
    NyseCalendarHarness internal lib;

    function setUp() public {
        vm.warp(1_790_000_000);
        MarketHours impl = new MarketHours();
        mh = MarketHours(
            address(new ERC1967Proxy(address(impl), abi.encodeCall(MarketHours.initialize, (admin, keeper))))
        );
        lib = new NyseCalendarHarness();
        Holiday[] memory h = new Holiday[](4);
        h[0] = Holiday({day: DAY_TG_2026, closeMinute: 0});
        h[1] = Holiday({day: DAY_BF_2026, closeMinute: 780});
        h[2] = Holiday({day: DAY_XMAS_2026, closeMinute: 0});
        h[3] = Holiday({day: DAY_JUL5_2027, closeMinute: 0});
        vm.startPrank(admin);
        mh.setHolidays(h);
        mh.setFallbackEnabled(true);
        vm.stopPrank();
    }

    function _k(uint256 ts) internal view returns (uint256) {
        return uint256(mh.kindAt(ts));
    }

    uint256 internal constant REG = uint256(SessionKind.REGULAR);
    uint256 internal constant EXT = uint256(SessionKind.EXTENDED);
    uint256 internal constant CLO = uint256(SessionKind.CLOSED);
    uint256 internal constant UNK = uint256(SessionKind.UNKNOWN);

    // ------------------------------------------------------------------ R8 extendedHasSingleProviderMarker

    function test_R8_boundaryMinutesOnAWeekday() public view {
        assertEq(_k(TUE_0359), EXT, "03:59 overnight tail");
        assertEq(_k(TUE_0400), EXT, "04:00 pre-market");
        assertEq(_k(TUE_0929), EXT, "09:29 pre-market");
        assertEq(_k(TUE_0930), REG, "09:30 open");
        assertEq(_k(TUE_1559), REG, "15:59");
        assertEq(_k(TUE_1600), EXT, "16:00 post-market");
        assertEq(_k(TUE_1959), EXT, "19:59 post-market");
        assertEq(_k(TUE_2000), EXT, "20:00 overnight reports EXTENDED");
    }

    function test_R8_overnightRunsSundayToFriday() public view {
        assertEq(_k(FRI_1959), EXT);
        assertEq(_k(FRI_2000), CLO, "no overnight into Saturday");
        assertEq(_k(SAT_1200), CLO);
        assertEq(_k(SUN_1959), CLO);
        assertEq(_k(SUN_2000), EXT, "Sunday 20:00 overnight opens");
        assertEq(_k(MON_0359), EXT);
    }

    function test_R8_dstSwitchDays() public view {
        assertEq(lib.etOffset(NyseCalendar.DST_START_2026 - 1), 5 hours);
        assertEq(lib.etOffset(NyseCalendar.DST_START_2026), 4 hours);
        assertEq(lib.etOffset(NyseCalendar.DST_END_2026 - 1), 4 hours);
        assertEq(lib.etOffset(NyseCalendar.DST_END_2026), 5 hours);
        // Spring forward: Sunday overnight opens at 20:00 EDT, Monday opens 09:30 EDT (one UTC hour earlier).
        assertEq(_k(DST_SUN_1959), CLO);
        assertEq(_k(DST_SUN_2000), EXT);
        assertEq(_k(DST_MON_0929), EXT);
        assertEq(_k(DST_MON_0930), REG);
        assertEq(DST_MON_0930 % 1 days, 13 hours + 30 minutes, "09:30 EDT = 13:30Z");
        assertEq(PRE_MON_0930 % 1 days, 14 hours + 30 minutes, "09:30 EST = 14:30Z");
        assertEq(_k(PRE_MON_0930 - 1 hours), EXT, "13:30Z the week before was still pre-market");
        // Fall back.
        assertEq(_k(STD_SUN_1959), CLO);
        assertEq(_k(STD_SUN_2000), EXT);
        assertEq(_k(STD_MON_0929), EXT);
        assertEq(_k(STD_MON_0930), REG);
    }

    function test_R8_holidaysAndEarlyClose() public view {
        assertEq(_k(WED_BEFORE_TG_2000), CLO, "no overnight into a holiday");
        assertEq(_k(TG_1200), CLO);
        assertEq(_k(TG_2000), EXT, "overnight into the half day");
        assertEq(_k(BF_1259), REG);
        assertEq(_k(BF_1300), EXT, "13:00 early close");
        assertEq(_k(BF_1959), EXT);
    }

    /// 406 instants across 2026-2028 (random plus dense around every DST switch and the holidays), expected kinds
    /// computed independently with Python zoneinfo (America/New_York) and the same session rules.
    function test_R8_matchesZoneinfoReference() public view {
        bytes memory vectors =
            hex"006b39262e02006bc2e0cf02006a2901b601006c80d99501006d2a773201006a931b1a02006a0e3f7a010069ddf21101"
            hex"00697e4ee802006c8c2e5901006dbae5cb01006ba65d3b010069ce3dce01006b1c3b4700006d7f60a202006da0d7e300"
            hex"006c37811500006b8c5e6302006ab756f002006a2f2fa002006b6db96f01006b0cd0920100698a3b9300006e75da5d01"
            hex"006b6ab92001006b82431602006ae1e0f901006aa7453c01006bd04b9d01006ba6e82301006e59c4c801006c50623b01"
            hex"006a07525600006e2e81df02006c08b91101006eb55e0301006c70350300006d61ea7e01006b536a6900006ac1d64102"
            hex"006b503d1201006d1fa17200006b93286101006a0cb42400006db7497c02006bbca03d010069647dd001006bab9e8301"
            hex"006de9ee0b01006ef95f3f02006bd4362c01006d66de8900006ae556c902006ca57bf101006cb9861e01006e204b9f01"
            hex"006ba3f6ac00006cc87fae00006cf2222101006aa01b7500006b335e2b01006bc6975901006b697f13010069ae466901"
            hex"0069fbc3e4010069b4971101006d09453100006e587d2d01006b940cc400006d7c5f6801006d9ca0ca01006e84d29e00"
            hex"006d1ad28501006ef11f4d02006c13dd9c00006a7ecfa901006eb99f2502006ae641d6020069ddc9e401006ca3204801"
            hex"006af4cac500006e6a3de501006e656ba802006cdd33ad01006b8b984f02006acdf29e01006c2e76cb00006cd27ee501"
            hex"006e0b855a00006be673db01006e690a2e01006dcd970b00006aecaf6b00006bec521b00006a24874e020069d3e68200"
            hex"006b2a728001006b8dffcc01006dfe11b701006e4220a601006b3bf3f900006a4fe05e00006bfbbf7302006ac152ee02"
            hex"006ba9891802006d01cb060100698a4ea9010069ad666402006c3107e100006ee9c6c4010069fee89b02006b9ecece02"
            hex"006ebc8f3001006bf3ab390100697af88001006bead68c01006ba5966101006be883ed02006a8ee1ae01006e8cdc3200"
            hex"006c9e474e00006e4c873101006ec673c2010069f4f7b000006baea07900006e46d53d00006addbdb102006ce3537202"
            hex"006babbaa600006a6d259c01006b55d1d602006c634f7501006e2015b801006a9b28ce01006bfc3d6702006deb693e01"
            hex"006968f77401006c3dcfda010069b177a100006cf91f7e01006ab0fef701006c41a22a01006c3c94fa02006ba853c102"
            hex"006de8106500006a1c968602006cd976c002006afe24ba01006cb9fa3700006aff894e01006a3e69ad010069cf400001"
            hex"0069d52088000069c6eab901006aaf28cc02006e1960c401006ebfdd5501006a882fbc01006e2fded7010069a9786001"
            hex"0069ac4b80020069ac6098020069ac75b0020069ac8ac8020069ac9fe0020069acb4f8020069acca10020069acdf2802"
            hex"0069acf440020069ad0958020069ad1e70020069ad3388020069ad48a0020069ad5db8020069ad72d0020069ad87e802"
            hex"0069ad9d00020069adb218020069adc730020069addc48020069adf16002006ae6027002006ae6178802006ae62ca002"
            hex"006ae641b802006ae656d002006ae66be802006ae6810002006ae6961802006ae6ab3002006ae6c04802006ae6d56002"
            hex"006ae6ea7802006ae6ff9002006ae714a802006ae729c002006ae73ed802006ae753f002006ae7690802006ae77e2002"
            hex"006ae7933802006ae7a85002006b95680002006b957d1802006b95923002006b95a74802006b95bc6002006b95d17802"
            hex"006b95e69002006b95fba802006b9610c002006b9625d802006b963af002006b96500802006b96652002006b967a3802"
            hex"006b968f5002006b96a46802006b96b98002006b96ce9802006b96e3b002006b96f8c802006b970de002006ccf1ef002"
            hex"006ccf340802006ccf492002006ccf5e3802006ccf735002006ccf886802006ccf9d8002006ccfb29802006ccfc7b002"
            hex"006ccfdcc802006ccff1e002006cd006f802006cd01c1002006cd0312802006cd0464002006cd05b5802006cd0707002"
            hex"006cd0858802006cd09aa002006cd0afb802006cd0c4d002006d754a0002006d755f1802006d75743002006d75894802"
            hex"006d759e6002006d75b37802006d75c89002006d75dda802006d75f2c002006d7607d802006d761cf002006d76320802"
            hex"006d76472002006d765c3802006d76715002006d76866802006d769b8002006d76b09802006d76c5b002006d76dac802"
            hex"006d76efe002006eaf00f002006eaf160802006eaf2b2002006eaf403802006eaf555002006eaf6a6802006eaf7f8002"
            hex"006eaf949802006eafa9b002006eafbec802006eafd3e002006eafe8f802006eaffe1002006eb0132802006eb0284002"
            hex"006eb03d5802006eb0527002006eb0678802006eb07ca002006eb091b802006eb0a6d002006b066b5001006b06796001"
            hex"006b06877001006b06958001006b06a39001006b06b1a001006b06bfb001006b06cdc001006b06dbd001006b06e9e001"
            hex"006b06f7f000006b07060000006b07141000006b07222000006b07303000006b073e4000006b074c5001006b075a6001"
            hex"006b07687001006b07768001006b07849002006b0792a002006b07a0b002006b07aec002006b07bcd002006b07cae002"
            hex"006b07d8f002006b07e70002006b07f51002006b08032002006b08113002006b081f4002006b082d5002006b083b6002"
            hex"006b08497002006b08578002006b08659002006b0873a002006b0881b002006b088fc002006b089dd002006b08abe002"
            hex"006b08b9f002006b08c80002006b08d61001006b08e42001006b08f23001006b09004001006b090e5001006b091c6001"
            hex"006b092a7001006b09388001006b09469001006b0954a001006b0962b001006b0970c001006b097ed001006b098ce001"
            hex"006b099af000006b09a90000006b09b71000006b09c52001006b09d33001006b09e14001006b09ef5001006b09fd6001"
            hex"006b0a0b7001006b0a198001006b0a279002006b0a35a002006b0a43b002006b0a51c002006c29b8c002006c29c6d002"
            hex"006c29d4e002006c29e2f002006c29f10002006c29ff1002006c2a0d2002006c2a1b3002006c2a294002006c2a375002"
            hex"006c2a456002006c2a537002006c2a618002006c2a6f9002006c2a7da002006c2a8bb002006c2a99c002006c2aa7d002"
            hex"006c2ab5e002006c2ac3f002006c2ad20002006c2ae01002006c2aee2002006c2afc3002006c2b0a4002006c2b185002"
            hex"006c2b266002006c2b347002006c2b428002006c2b509002006c2b5ea002006c2b6cb002006c2b7ac002006c2b88d002"
            hex"006c2b96e002006c2ba4f002006c2bb30002006c2bc11002006c2bcf2002006c2bdd3002006c2beb4002006c2bf95002"
            hex"006c2c076002006c2c157002006c2c238001006c2c319001006c2c3fa001006c2c4db001";
        assertEq(vectors.length, 406 * 6);
        for (uint256 i; i < vectors.length; i += 6) {
            uint256 ts;
            for (uint256 j; j < 5; ++j) {
                ts = (ts << 8) | uint8(vectors[i + j]);
            }
            uint256 want = uint8(vectors[i + 5]);
            assertEq(_k(ts), want, vm.toString(ts));
        }
    }

    function testFuzz_R8_neverHaltedNeverReverts(uint256 ts) public view {
        ts = bound(ts, 0, type(uint64).max);
        uint256 k = _k(ts);
        assertLe(k, UNK);
        if (!lib.supported(ts)) assertEq(k, UNK);
        else assertTrue(k != UNK);
    }

    // ------------------------------------------------------------------ R9 unknownCalendar

    function test_R9_unknownCalendar() public {
        vm.prank(admin);
        mh.setFallbackEnabled(false);
        assertEq(_k(TUE_0930), UNK, "no sessions, no fallback");
        vm.prank(admin);
        mh.setFallbackEnabled(true);
        assertEq(_k(TUE_0930), REG);
        assertEq(_k(NyseCalendar.SUPPORTED_FROM - 1), UNK, "before 2026");
        assertEq(_k(NyseCalendar.SUPPORTED_TO), UNK, "from 2029");
        assertEq(_k(Y2028_LAST_1000), REG);
    }

    function test_R9_pushedCalendarWinsAndLegacyPushIsRegular() public {
        Session[] memory s = new Session[](1);
        s[0] = Session({open: uint64(TUE_0400), close: uint64(TUE_0930)});
        SessionKind[] memory k = new SessionKind[](1);
        k[0] = SessionKind.EXTENDED;
        vm.prank(keeper);
        mh.setSessionsWithKinds(s, k);
        assertEq(_k(TUE_0400), EXT);
        assertEq(_k(TUE_0930), REG, "past pushed coverage: fallback");
        assertEq(uint256(mh.sessionKinds()[0]), EXT);

        vm.prank(keeper);
        mh.setSessions(s);
        assertEq(_k(TUE_0400), REG, "legacy push stores REGULAR");
        assertEq(mh.sessionKinds().length, 1);
        assertTrue(mh.isOpen(TUE_0400), "isOpen unchanged");
    }

    // ------------------------------------------------------------------ R10 accessControl and bounds

    function test_R10_holidayAndFallbackAreAdminOnly() public {
        Holiday[] memory h = new Holiday[](0);
        bytes32 adminRole = mh.DEFAULT_ADMIN_ROLE();
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, keeper, adminRole)
        );
        vm.prank(keeper);
        mh.setHolidays(h);
        vm.expectRevert(
            abi.encodeWithSelector(IAccessControl.AccessControlUnauthorizedAccount.selector, keeper, adminRole)
        );
        vm.prank(keeper);
        mh.setFallbackEnabled(false);
    }

    function test_R10_holidayListBounds() public {
        Holiday[] memory h = new Holiday[](65);
        for (uint256 i; i < 65; ++i) {
            h[i] = Holiday({day: uint32(20000 + i), closeMinute: 0});
        }
        vm.startPrank(admin);
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.TooManyHolidays.selector, 65));
        mh.setHolidays(h);

        h = new Holiday[](64);
        for (uint256 i; i < 64; ++i) {
            h[i] = Holiday({day: uint32(20000 + i), closeMinute: 0});
        }
        mh.setHolidays(h);
        assertEq(mh.holidays().length, 64);

        h = new Holiday[](2);
        h[0] = Holiday({day: 20001, closeMinute: 0});
        h[1] = Holiday({day: 20001, closeMinute: 0});
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.HolidaysUnsorted.selector, 1));
        mh.setHolidays(h);

        h = new Holiday[](1);
        h[0] = Holiday({day: 20001, closeMinute: 960});
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.InvalidHoliday.selector, 0));
        mh.setHolidays(h);
        h[0] = Holiday({day: 20001, closeMinute: 570});
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.InvalidHoliday.selector, 0));
        mh.setHolidays(h);
        vm.stopPrank();
    }

    function test_R10_kindedPushValidation() public {
        Session[] memory s = new Session[](1);
        s[0] = Session({open: uint64(TUE_0400), close: uint64(TUE_0930)});
        SessionKind[] memory k = new SessionKind[](2);
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.SessionKindsLength.selector, 1, 2));
        vm.prank(keeper);
        mh.setSessionsWithKinds(s, k);

        k = new SessionKind[](1);
        k[0] = SessionKind.HALTED;
        vm.expectRevert(abi.encodeWithSelector(IMarketHours.InvalidSessionKind.selector, 0));
        vm.prank(keeper);
        mh.setSessionsWithKinds(s, k);
    }
}
