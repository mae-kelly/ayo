// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

contract SimpleArbitrage {
    address public owner;
    
    constructor() {
        owner = msg.sender;
    }
    
    function test() public pure returns (string memory) {
        return "Hello World";
    }
}