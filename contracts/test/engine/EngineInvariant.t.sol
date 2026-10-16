// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {EngineBase} from "./EngineBase.sol";
import {EngineHandler} from "./EngineHandler.sol";
import {EngineStorage} from "../../src/engine/EngineStorage.sol";
import {Funding} from "../../src/libs/Funding.sol";
import {Series} from "../../src/libs/OptionTypes.sol";

/// @notice Engine todo R16: handler-based invariants over buys, sells, round trips, transfers, the HALTED queue,
/// accruals, price moves, session changes and time.
contract EngineInvariantTest is EngineBase {
    EngineHandler internal handler;
    bytes32[] internal ids;
    address[] internal actors;
    uint256 internal usdgSupply;
    mapping(address => uint256) internal startBalance;

    function setUp() public override {
        super.setUp();
        ids.push(_list(address(nvda), true, 100e18, DAILY));
        ids.push(_list(address(nvda), false, 95e18, WEEKLY));
        ids.push(_list(address(nvda), true, 110e18, WEEKLY));
        ids.push(_list(address(tsla), false, 200e18, DAILY));
        ids.push(_list(address(tsla), true, 220e18, WEEKLY));
        actors.push(alice);
        actors.push(bob);
        actors.push(makeAddr("carol"));
        _fund(actors[2]);
        address[] memory ss = new address[](2);
        ss[0] = address(nvda);
        ss[1] = address(tsla);
        handler = new EngineHandler(engine, registry, guard, pool, usdg, actors, ids, ss);
        for (uint256 i; i < actors.length; ++i) {
            startBalance[actors[i]] = usdg.balanceOf(actors[i]);
        }
        usdgSupply = usdg.totalSupply();
        targetContract(address(handler));
    }

    function _risk(bytes32 id) internal view returns (int256[9] memory r) {
        EngineStorage.SeriesRisk memory s = engine.seriesRisk(id);
        r = [int256(uint256(s.value)), s.delta, int256(uint256(s.gamma)), int256(uint256(s.vega)), s.sc0, s.sc1, s.sc2, s.sc3, 0];
    }

    /// 16 (todo 07b R2). The live list of each stock is exactly its series with tokens outstanding, and each live
    /// series' packed index points back at it.
    function invariant_liveSetIsNonZeroSupply() public view {
        address[] memory ss = engine.stocks();
        for (uint256 s; s < ss.length; ++s) {
            bytes32[] memory live = engine.liveSeries(ss[s]);
            for (uint256 j; j < live.length; ++j) {
                assertEq(engine.seriesInfo(live[j]).liveIdx, j + 1, "index points back");
                assertGt(_token(live[j]).totalSupply(), 0, "live has supply");
            }
            bytes32[] memory all = engine.seriesOfStock(ss[s]);
            uint256 withSupply;
            for (uint256 j; j < all.length; ++j) {
                if (_token(all[j]).totalSupply() != 0) ++withSupply;
            }
            assertEq(live.length, withSupply, "every series with supply is live");
        }
    }

    /// 1. norm never rises
    function invariant_normMonotone() public view {
        assertFalse(handler.normRose());
    }

    /// 2. norm stays in [MIN_NORM, 1e18]
    function invariant_normBounds() public view {
        for (uint256 i; i < ids.length; ++i) {
            uint256 n = registry.seriesOf(ids[i]).norm;
            assertLe(n, 1e18);
            assertGe(n, Funding.MIN_NORM);
        }
    }

    /// 3. the engine's copy of norm / lastAccrual equals the registry's
    function invariant_registryMirror() public view {
        for (uint256 i; i < ids.length; ++i) {
            Series memory s = registry.seriesOf(ids[i]);
            EngineStorage.SeriesInfo memory e = engine.seriesInfo(ids[i]);
            if (!e.known) continue;
            assertEq(e.norm, s.norm);
            assertEq(e.lastAccrual, s.lastAccrual);
        }
    }

    /// 4. totalLiability equals an independent recomputation (supply x norm x V at current prices)
    function invariant_totalLiabilityEqualsRecomputation() public view {
        assertEq(engine.totalLiability(), _liabilityRef());
    }

    /// 5. each name book is exactly the sum of its series' contributions
    function invariant_nameBookIsSumOfSeries() public view {
        address[] memory ss = engine.stocks();
        for (uint256 i; i < ss.length; ++i) {
            bytes32[] memory sids = engine.seriesOfStock(ss[i]);
            int256[9] memory sum;
            for (uint256 j; j < sids.length; ++j) {
                int256[9] memory r = _risk(sids[j]);
                for (uint256 f; f < 8; ++f) sum[f] += r[f];
            }
            EngineStorage.NameBook memory nb = engine.nameBook(ss[i]);
            assertEq(int256(nb.value), sum[0]);
            assertEq(nb.delta, sum[1]);
            assertEq(int256(nb.gamma), sum[2]);
            assertEq(int256(nb.vega), sum[3]);
            for (uint256 f; f < 4; ++f) assertEq(nb.sc[f], sum[4 + f]);
        }
    }

    /// 6. bookValue is the sum of the name books' values
    function invariant_bookValueIsSumOfNames() public view {
        address[] memory ss = engine.stocks();
        uint256 total;
        for (uint256 i; i < ss.length; ++i) total += engine.nameBook(ss[i]).value;
        assertEq(engine.bookValue(), total);
    }

    /// 7. USDG is conserved: nothing minted or burned by the system, it only moves between actors and the pool
    function invariant_usdgConserved() public view {
        uint256 sum = usdg.balanceOf(address(pool)) + usdg.balanceOf(address(engine));
        for (uint256 i; i < actors.length; ++i) sum += usdg.balanceOf(actors[i]);
        assertEq(sum, usdgSupply);
    }

    /// 8. the engine never holds USDG
    function invariant_engineHoldsNoUsdg() public view {
        assertEq(usdg.balanceOf(address(engine)), 0);
    }

    /// 9. pool cash moves only by trades: initial + buys - sells (funding moves no USDG)
    function invariant_poolCashOnlyByTrades() public view {
        assertEq(usdg.balanceOf(address(pool)), POOL_CASH + handler.ghostCosts() - handler.ghostProceeds());
    }

    /// 10. buyers: every USDG an actor lost is a buy cost, every USDG gained a sell proceed; no debt exists
    function invariant_buyerOutflowIsPremiumOnly() public view {
        for (uint256 i; i < actors.length; ++i) {
            address a = actors[i];
            assertEq(usdg.balanceOf(a) + handler.paidBy(a), startBalance[a] + handler.receivedBy(a));
        }
    }

    /// 11. escrowed tokens == open tickets, per series
    function invariant_escrowMatchesTickets() public view {
        uint256 n = handler.openTicketCount();
        for (uint256 i; i < ids.length; ++i) {
            uint256 want;
            for (uint256 k; k < n; ++k) {
                EngineStorage.Ticket memory t = engine.queuedSell(handler.openTicketAt(k));
                if (t.id == ids[i] && t.open) want += t.tokens;
            }
            assertEq(IERC20(registry.seriesOf(ids[i]).token).balanceOf(address(engine)), want);
        }
    }

    /// 12. supply x norm solvency per series: holders' units sum to supply x norm (balances add up to supply)
    function invariant_supplyNormSolvency() public view {
        for (uint256 i; i < ids.length; ++i) {
            Series memory s = registry.seriesOf(ids[i]);
            IERC20 t = IERC20(s.token);
            uint256 bal = t.balanceOf(address(engine));
            uint256 units = Math.mulDiv(bal, s.norm, WAD);
            for (uint256 a; a < actors.length; ++a) {
                bal += t.balanceOf(actors[a]);
                units += Math.mulDiv(t.balanceOf(actors[a]), s.norm, WAD);
            }
            assertEq(bal, t.totalSupply());
            assertLe(units, Math.mulDiv(t.totalSupply(), s.norm, WAD));
        }
    }

    /// 13. no Panic anywhere
    function invariant_noPanic() public view {
        assertFalse(handler.panicked());
    }

    /// 14. same-block round trips never profit
    function invariant_noRoundTripProfit() public view {
        assertFalse(handler.roundTripProfit());
    }

    /// 15. netGreeks is the name book (holders' side)
    function invariant_netGreeksAreTheBook() public view {
        address[] memory ss = engine.stocks();
        for (uint256 i; i < ss.length; ++i) {
            (int256 d, int256 g, int256 v) = engine.netGreeks(ss[i]);
            EngineStorage.NameBook memory nb = engine.nameBook(ss[i]);
            assertEq(d, nb.delta);
            assertEq(g, int256(nb.gamma));
            assertEq(v, int256(nb.vega));
        }
    }
}
