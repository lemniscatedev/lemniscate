// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice Fork-only stand-in for the Safe that runs the timelock (decision 9): a 1-of-1 executor owned by one
/// address, exposing the Safe getters the post-deploy check reads. Fork relaxation, written down in the deploy runbook:
/// mainnet refuses anything but a real Safe with at least 3 of 5 signers. Never deployed by the mainnet profile.
contract ForkSafe {
    address public immutable owner;

    error NotOwner();
    error CallFailed(bytes reason);

    constructor(address owner_) {
        owner = owner_;
    }

    function exec(address target, uint256 value, bytes calldata data) external payable returns (bytes memory out) {
        if (msg.sender != owner) revert NotOwner();
        bool ok;
        // Arbitrary target on purpose (a Safe executes any call), and only the single owner above can reach it.
        // nosemgrep: solidity.security.arbitrary-low-level-call.arbitrary-low-level-call
        (ok, out) = target.call{value: value}(data);
        if (!ok) revert CallFailed(out);
    }

    function getThreshold() external pure returns (uint256) {
        return 1;
    }

    function getOwners() external view returns (address[] memory owners) {
        owners = new address[](1);
        owners[0] = owner;
    }

    receive() external payable {}
}
