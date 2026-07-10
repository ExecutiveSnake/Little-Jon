// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Minimal mintable ERC-20 standing in for USDe in tests. 18 decimals, matching
///         the real USDe token.
contract MockUSDe is ERC20 {
    constructor() ERC20("Mock USDe", "USDe") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
