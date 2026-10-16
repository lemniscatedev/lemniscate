// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {OptionToken} from "../src/OptionToken.sol";

contract OptionTokenTest is Test {
    OptionToken private token;

    function setUp() public {
        token = new OptionToken(unicode"NVDA² Power Token", "NVDA2", address(this));
    }

    function testOnlyEngineCanMintAndBurn() public {
        address holder = makeAddr("holder");
        token.mint(holder, 10 ether);
        assertEq(token.balanceOf(holder), 10 ether);

        vm.expectRevert(OptionToken.NotEngine.selector);
        vm.prank(makeAddr("outsider"));
        token.mint(holder, 1 ether);

        vm.expectRevert(OptionToken.NotEngine.selector);
        vm.prank(makeAddr("outsider"));
        token.burn(holder, 1 ether);

        token.burn(holder, 3 ether);
        assertEq(token.balanceOf(holder), 7 ether);
        assertEq(token.totalSupply(), 7 ether);
    }

    function testPermitSetsAllowanceAndConsumesNonce() public {
        uint256 ownerKey = 0xA11CE;
        address owner = vm.addr(ownerKey);
        address spender = makeAddr("spender");
        uint256 value = 2 ether;
        uint256 deadline = block.timestamp + 1 days;

        bytes32 permitTypehash =
            keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
        bytes32 structHash = keccak256(abi.encode(permitTypehash, owner, spender, value, 0, deadline));
        bytes32 digest = keccak256(abi.encodePacked("\x19\x01", token.DOMAIN_SEPARATOR(), structHash));
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(ownerKey, digest);

        token.permit(owner, spender, value, deadline, v, r, s);

        assertEq(token.allowance(owner, spender), value);
        assertEq(token.nonces(owner), 1);
    }
}
