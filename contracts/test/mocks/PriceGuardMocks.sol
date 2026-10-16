// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {SessionKind} from "../../src/libs/OptionTypes.sol";

interface IPokeTarget {
    function poke(address stock) external;
}

/// @notice Chainlink-style feed with a revert switch and full control of the round fields.
contract MockGuardFeed {
    uint8 public decimals;
    uint80 public roundId;
    int256 public answer;
    uint256 public updatedAt;
    bool public shouldRevert;
    bool public shortReturn;

    constructor(uint8 decimals_, int256 answer_) {
        decimals = decimals_;
        answer = answer_;
        updatedAt = block.timestamp;
        roundId = 1;
    }

    /// @notice New round at the current block time.
    function push(int256 answer_) external {
        answer = answer_;
        updatedAt = block.timestamp;
        ++roundId;
    }

    function setRound(int256 answer_, uint256 updatedAt_) external {
        answer = answer_;
        updatedAt = updatedAt_;
        ++roundId;
    }

    function setRevert(bool v) external {
        shouldRevert = v;
    }

    function setShortReturn(bool v) external {
        shortReturn = v;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!shouldRevert, "feed down");
        if (shortReturn) {
            assembly {
                mstore(0, 1)
                return(0, 32)
            }
        }
        return (roundId, answer, updatedAt, updatedAt, roundId);
    }
}

/// @notice Stock token multiplier surface that switches uiMultiplier() to the pending value at effectiveAt, the way
/// the mainnet tokens read after a change (uiMultiplier == newUIMultiplier once effectiveAt has passed).
contract MockSwitchingStock {
    uint256 private _current = 1e18;
    uint256 private _pending = 1e18;
    uint256 public effectiveAt;
    bool public oraclePaused;
    bool public shouldRevert;

    function setMultiplier(uint256 m) external {
        _current = m;
        _pending = m;
        effectiveAt = 0;
    }

    function schedule(uint256 pending, uint256 effectiveAt_) external {
        // Settle any change already in effect first.
        if (effectiveAt != 0 && block.timestamp >= effectiveAt) _current = _pending;
        _pending = pending;
        effectiveAt = effectiveAt_;
    }

    function setOraclePaused(bool v) external {
        oraclePaused = v;
    }

    function setRevert(bool v) external {
        shouldRevert = v;
    }

    function uiMultiplier() external view returns (uint256) {
        require(!shouldRevert, "token down");
        if (effectiveAt != 0 && block.timestamp >= effectiveAt) return _pending;
        return _current;
    }

    function newUIMultiplier() external view returns (uint256) {
        require(!shouldRevert, "token down");
        return _pending;
    }

}

/// @notice Stock token whose oraclePaused() reverts (for R6).
contract MockPausedRevertsStock {
    function uiMultiplier() external pure returns (uint256) {
        return 1e18;
    }

    function newUIMultiplier() external pure returns (uint256) {
        return 1e18;
    }

    function effectiveAt() external pure returns (uint256) {
        return 0;
    }

    function oraclePaused() external pure returns (bool) {
        revert("no");
    }
}

/// @notice Calendar stub returning a fixed kind, or reverting, or returning an out-of-range word.
contract MockKindHours {
    SessionKind public kind = SessionKind.REGULAR;
    bool public shouldRevert;
    bool public garbage;

    function setKind(SessionKind k) external {
        kind = k;
    }

    function setRevert(bool v) external {
        shouldRevert = v;
    }

    function setGarbage(bool v) external {
        garbage = v;
    }

    function kindAt(uint256) external view returns (uint256) {
        require(!shouldRevert, "calendar down");
        if (garbage) return 77;
        return uint256(kind);
    }
}

/// @notice L2 sequencer uptime feed: answer 0 = up, 1 = down; startedAt = when the status last changed.
contract MockSequencerFeed {
    int256 public answer;
    uint256 public startedAt;
    bool public shouldRevert;

    function set(int256 answer_, uint256 startedAt_) external {
        answer = answer_;
        startedAt = startedAt_;
    }

    function setRevert(bool v) external {
        shouldRevert = v;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!shouldRevert, "seq down");
        return (1, answer, startedAt, startedAt, 1);
    }
}

/// @notice Feed that tries to write PriceGuard state from inside latestRoundData.
contract ReentrantFeed {
    address public target;
    address public stock;
    uint8 public constant decimals = 8;
    bool public armed;

    function arm(address target_, address stock_) external {
        target = target_;
        stock = stock_;
        armed = true;
    }

    /// @dev Swallows the nested failure so the outer read still gets an answer: the test then checks that only the
    /// outer (legitimate) poke wrote anything.
    function latestRoundData() external returns (uint80, int256, uint256, uint256, uint80) {
        if (armed) {
            try IPokeTarget(target).poke(stock) {} catch {}
        }
        return (1, 100e8, block.timestamp, block.timestamp, 1);
    }
}

/// @notice Feed that burns all gas it is given.
contract GasBurnerFeed {
    uint8 public constant decimals = 8;

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        uint256 x;
        while (gasleft() > 0) {
            x = uint256(keccak256(abi.encode(x)));
        }
        return (1, int256(x), block.timestamp, block.timestamp, 1);
    }
}
