// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDG} from "../src/MockUSDG.sol";
import {BoundedVIMarkets} from "../src/BoundedVIMarkets.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

contract Handler is Test {
    BoundedVIMarkets public mk;
    MockUSDG public usdg;
    uint256 public id;
    address[] public actors;
    uint256 public lastK;

    constructor(BoundedVIMarkets mk_, MockUSDG usdg_, uint256 id_) {
        mk = mk_;
        usdg = usdg_;
        id = id_;
        for (uint256 i = 0; i < 4; i++) {
            address a = address(uint160(0x1000 + i));
            actors.push(a);
            usdg.mint(a, 10_000e6);
            vm.prank(a);
            usdg.approve(address(mk), type(uint256).max);
        }
        lastK = k();
    }

    function k() public view returns (uint256) {
        BoundedVIMarkets.Market memory m = mk.getMarket(id);
        return uint256(m.poolUp) * m.poolDown;
    }

    function buy(uint256 who, bool up, uint256 invest) external {
        address a = actors[who % actors.length];
        invest = bound(invest, 1, usdg.balanceOf(a));
        vm.prank(a);
        try mk.buy(id, up ? BoundedVIMarkets.Side.Up : BoundedVIMarkets.Side.Down, invest, 0) {} catch {}
    }

    function sell(uint256 who, bool up, uint256 shares) external {
        address a = actors[who % actors.length];
        (uint256 u, uint256 d) = mk.sharesOf(id, a);
        uint256 held = up ? u : d;
        if (held == 0) return;
        shares = bound(shares, 1, held);
        vm.prank(a);
        try mk.sell(id, up ? BoundedVIMarkets.Side.Up : BoundedVIMarkets.Side.Down, shares, 0) {} catch {}
    }

    function actorCount() external view returns (uint256) {
        return actors.length;
    }
}

contract InvariantTest is Test {
    MockUSDG usdg;
    BoundedVIMarkets mk;
    Handler handler;
    uint256 id;

    function setUp() public {
        usdg = new MockUSDG();
        mk = new BoundedVIMarkets(IERC20(address(usdg)), address(this), address(this));
        usdg.mint(address(this), 10_000e6);
        usdg.approve(address(mk), type(uint256).max);
        id = mk.createMarket(bytes32(0), address(this), 10_000, 2_000, 50_000, 1_000e6, 5000);
        handler = new Handler(mk, usdg, id);
        targetContract(address(handler));
    }

    function invariant_productNeverFalls() public {
        assertGe(handler.k(), 1_000e6 * 1_000e6);
    }

    function invariant_solvent() public view {
        BoundedVIMarkets.Market memory m = mk.getMarket(id);
        uint256 up = m.poolUp;
        uint256 down = m.poolDown;
        for (uint256 i = 0; i < handler.actorCount(); i++) {
            (uint256 u, uint256 d) = mk.sharesOf(id, handler.actors(i));
            up += u;
            down += d;
        }
        assertEq(up, m.collateral);
        assertEq(down, m.collateral);
        assertEq(usdg.balanceOf(address(mk)), uint256(m.collateral) + m.fees);
    }
}
