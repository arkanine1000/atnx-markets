// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDG} from "../src/MockUSDG.sol";
import {BoundedVIMarkets} from "../src/BoundedVIMarkets.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// Deploys MockUSDG and BoundedVIMarkets with the deployer as owner,
/// operator, oracle and fee recipient (one keeper key on the testnet),
/// approves the markets contract for the deployer's USDG and mints the
/// deployer 10,000 mock USDG to seed the first markets.
///
///   PRIVATE_KEY=0x... forge script script/Deploy.s.sol --rpc-url robinhood_testnet --broadcast --slow
contract Deploy is Script {
    function run() external {
        uint256 pk = vm.envUint("PRIVATE_KEY");
        address deployer = vm.addr(pk);
        vm.startBroadcast(pk);

        MockUSDG usdg = new MockUSDG();
        BoundedVIMarkets markets = new BoundedVIMarkets(IERC20(address(usdg)), deployer, deployer);
        usdg.approve(address(markets), type(uint256).max);
        usdg.mint(deployer, 10_000e6);

        vm.stopBroadcast();

        console.log("chainId", block.chainid);
        console.log("deployer", deployer);
        console.log("MockUSDG", address(usdg));
        console.log("BoundedVIMarkets", address(markets));
    }
}
