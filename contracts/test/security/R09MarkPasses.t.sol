// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {EngineStorage} from "../../src/engine/EngineStorage.sol";
import {EngineBase} from "../engine/EngineBase.sol";

/// @notice Round-2 review R09 (MEDIUM): the NAV envelope [lo, hi] and the funding clock tc only reset when every
/// non-dust live series of a name was accrued in the same second. Mainnet keeper batching (40 per tx), off-session
/// trades or a few $1 buys in more series than one batch prevented that forever: the claim bound widened to the
/// all-time price range and the deposit bound fell to minus the name's book. The envelope now resets per pass: once
/// every series with units in a tier has been re-marked since the pass began, in any number of transactions.
contract R09MarkPassesTest is EngineBase {
    bytes32[] internal ids;

    function _book(uint256 n) internal {
        for (uint256 i; i < n; ++i) {
            bool isCall = i % 2 == 0;
            uint128 k = uint128(90e18 + (i % 21) * 1e18);
            uint32 tau = i % 3 == 0 ? WEEKLY : DAILY;
            bytes32 id = _list(address(nvda), isCall, k + uint128(i / 21) * 1e15, tau);
            _buy(alice, id, 300e18);
            ids.push(id);
        }
    }

    /// @dev The keeper's pass: ids in batches of `batch`, each batch in its own transaction a few seconds apart.
    function _keeperPass(uint256 batch) internal {
        for (uint256 i; i < ids.length; i += batch) {
            uint256 end = i + batch > ids.length ? ids.length : i + batch;
            bytes32[] memory b = new bytes32[](end - i);
            for (uint256 j = i; j < end; ++j) {
                b[j - i] = ids[j];
            }
            engine.accrueMany(b);
            skip(3);
        }
    }

    function _absDiff(uint256 a, uint256 b) internal pure returns (uint256) {
        return a > b ? a - b : b - a;
    }

    /// @dev Reviewer scenario: more series than one batch, the price ranges for weeks, the keeper runs every 5 minutes
    /// in batches. After a pass at a steady S both bounds equal the book (the exact liability).
    function test_R09_batchedKeeperPassesKeepTheBoundsTight() public {
        _book(60);
        uint256[6] memory path = [uint256(92e18), 108e18, 95e18, 110e18, 97e18, 103e18];
        for (uint256 d; d < path.length; ++d) {
            guard.setS(address(nvda), path[d]);
            skip(5 minutes);
            _keeperPass(40);
        }
        // one more pass at the final, steady S
        skip(5 minutes);
        _keeperPass(40);
        uint256 book = engine.bookValue();
        uint256 high = engine.navLiability(true);
        uint256 low = engine.navLiability(false);
        assertLe(high - book, book / 1_000, "claim bound tight after the pass (was all-time range x units)");
        // within the funding of one keeper interval (value x ~10 min / tau), not minus the book
        assertLe(_absDiff(book, low), book / 100, "deposit bound tight (was minus the book)");
        EngineStorage.MarkTier memory t = engine.markTier(address(nvda), 0);
        assertGe(t.tc + 10 minutes, vm.getBlockTimestamp(), "tc follows the keeper's passes");
    }

    /// @dev PROPERTY: for any series count across the batch boundary and any batch size, (i) the bounds always
    /// bracket the exact liability and (ii) after a complete keeper pass at a steady S they are within the
    /// first-order funding of the pass of the exact liability.
    function testFuzz_R09_boundsTightAfterAnyBatchedPass(uint8 n, uint8 batch, uint256 seed) public {
        n = uint8(bound(n, 5, 70));
        batch = uint8(bound(batch, 1, 45));
        _book(n);
        for (uint256 r; r < 4; ++r) {
            uint256 s = bound(uint256(keccak256(abi.encode(seed, r))), 85e18, 115e18);
            guard.setS(address(nvda), s);
            uint256 exact = _liabilityRef();
            assertGe(engine.navLiability(true) + 1e12, exact, "high >= exact");
            skip(5 minutes);
            _keeperPass(batch);
        }
        skip(1);
        _keeperPass(batch);
        uint256 ex = _liabilityRef();
        uint256 hi = engine.navLiability(true);
        uint256 lo = engine.navLiability(false);
        assertGe(hi + 1e12, ex, "high >= exact");
        assertLe(lo, ex + ex / 1_000 + 1e12, "low <= exact");
        assertLe(hi - ex, ex / 200 + 1e12, "high tight after the pass");
        assertLe(ex - (lo < ex ? lo : ex), ex / 50 + 1e12, "low tight after the pass");
    }
}
