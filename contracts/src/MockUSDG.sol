// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title Mock USDG
/// @notice A testnet stand-in for Global Dollar (USDG), 6 decimals like the
///         real one. Anyone may mint up to MAX_MINT per call, so no faucet
///         is needed to try the markets. Testnet only; the token has no value.
contract MockUSDG is ERC20 {
    uint256 public constant MAX_MINT = 10_000e6;

    error MintTooLarge(uint256 requested, uint256 max);

    constructor() ERC20("Mock Global Dollar", "USDG") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        if (amount > MAX_MINT) revert MintTooLarge(amount, MAX_MINT);
        _mint(to, amount);
    }
}
