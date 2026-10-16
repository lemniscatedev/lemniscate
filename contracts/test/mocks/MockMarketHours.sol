// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

contract MockMarketHours {
    bool public open = true;
    bool public shouldRevert;

    function setOpen(bool open_) external {
        open = open_;
    }

    function setShouldRevert(bool shouldRevert_) external {
        shouldRevert = shouldRevert_;
    }

    function isOpen(uint256) external view returns (bool) {
        require(!shouldRevert);
        return open;
    }
}
