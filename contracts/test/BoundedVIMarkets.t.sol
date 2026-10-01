// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {Test} from "forge-std/Test.sol";
import {MockUSDG} from "../src/MockUSDG.sol";
import {BoundedVIMarkets} from "../src/BoundedVIMarkets.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

contract BoundedVIMarketsTest is Test {
    MockUSDG usdg;
    BoundedVIMarkets mk;

    address oracle = makeAddr("oracle");
    address alice = makeAddr("alice");
    address bob = makeAddr("bob");
    address carol = makeAddr("carol");
    address[3] traders;

    uint256 constant SEED = 1_000e6;
    uint64 constant START = 10_000; // VI 100.00
    uint64 constant LOWER = 2_000; // 20
    uint64 constant UPPER = 50_000; // 500
    bytes32 constant REF = bytes32(uint256(0xabc));

    BoundedVIMarkets.Side constant UP = BoundedVIMarkets.Side.Up;
    BoundedVIMarkets.Side constant DOWN = BoundedVIMarkets.Side.Down;

    function setUp() public {
        usdg = new MockUSDG();
        mk = new BoundedVIMarkets(IERC20(address(usdg)), oracle, address(this));
        usdg.mint(address(this), 10_000e6);
        usdg.approve(address(mk), type(uint256).max);
        traders = [alice, bob, carol];
        for (uint256 i = 0; i < 3; i++) {
            usdg.mint(traders[i], 10_000e6);
            vm.prank(traders[i]);
            usdg.approve(address(mk), type(uint256).max);
        }
    }

    function create() internal returns (uint256) {
        return mk.createMarket(REF, address(this), START, LOWER, UPPER, SEED, 5000);
    }

    function buyAs(address who, uint256 id, BoundedVIMarkets.Side side, uint256 invest) internal returns (uint256) {
        vm.prank(who);
        return mk.buy(id, side, invest, 0);
    }

    function sellAs(address who, uint256 id, BoundedVIMarkets.Side side, uint256 shares) internal returns (uint256) {
        vm.prank(who);
        return mk.sell(id, side, shares, 0);
    }

    // Every side's pool plus every holder's shares equals the collateral,
    // and the token balance covers collateral plus fees.
    function assertSolvent(uint256 id) internal view {
        BoundedVIMarkets.Market memory m = mk.getMarket(id);
        uint256 up = m.poolUp;
        uint256 down = m.poolDown;
        address[4] memory holders = [alice, bob, carol, address(this)];
        for (uint256 i = 0; i < holders.length; i++) {
            (uint256 u, uint256 d) = mk.sharesOf(id, holders[i]);
            up += u;
            down += d;
        }
        if (m.status != BoundedVIMarkets.Status.Resolved) {
            assertEq(up, m.collateral, "UP side != collateral");
            assertEq(down, m.collateral, "DOWN side != collateral");
        }
        assertGe(usdg.balanceOf(address(mk)), uint256(m.collateral) + m.fees, "token balance < collateral + fees");
    }

    // ---------------------------------------------------------------- create

    function test_create_pullsSeedAndSplitsPools() public {
        uint256 before = usdg.balanceOf(address(this));
        vm.expectEmit(true, true, true, true);
        emit BoundedVIMarkets.MarketCreated(1, REF, address(this), START, LOWER, UPPER, SEED, 5000);
        uint256 id = create();
        assertEq(id, 1);
        BoundedVIMarkets.Market memory m = mk.getMarket(id);
        assertEq(m.poolUp, SEED);
        assertEq(m.poolDown, SEED);
        assertEq(m.collateral, SEED);
        assertEq(uint8(m.status), uint8(BoundedVIMarkets.Status.Open));
        assertEq(before - usdg.balanceOf(address(this)), SEED);
        assertEq(mk.priceUp(id), 0.5e18);
        assertSolvent(id);
    }

    function test_create_onlyOperator() public {
        vm.prank(alice);
        vm.expectRevert(BoundedVIMarkets.NotOperator.selector);
        mk.createMarket(REF, alice, START, LOWER, UPPER, SEED, 5000);
    }

    function test_create_badBoundsAndUpBps() public {
        vm.expectRevert(BoundedVIMarkets.BadBounds.selector);
        mk.createMarket(REF, address(this), START, START, UPPER, SEED, 5000);
        vm.expectRevert(BoundedVIMarkets.BadBounds.selector);
        mk.createMarket(REF, address(this), START, LOWER, START, SEED, 5000);
        vm.expectRevert(BoundedVIMarkets.BadUpBps.selector);
        mk.createMarket(REF, address(this), START, LOWER, UPPER, SEED, 400);
        vm.expectRevert(BoundedVIMarkets.BadUpBps.selector);
        mk.createMarket(REF, address(this), START, LOWER, UPPER, SEED, 9600);
        vm.expectRevert(BoundedVIMarkets.ZeroAmount.selector);
        mk.createMarket(REF, address(this), START, LOWER, UPPER, 0, 5000);
    }

    function test_create_skewedStartHandsExcessToCreator() public {
        uint256 id = mk.createMarket(REF, alice, START, LOWER, UPPER, SEED, 7000);
        BoundedVIMarkets.Market memory m = mk.getMarket(id);
        assertEq(m.poolDown, SEED);
        assertEq(m.poolUp, SEED * 3000 / 7000);
        (uint256 u, uint256 d) = mk.sharesOf(id, alice);
        assertEq(u, SEED - m.poolUp);
        assertEq(d, 0);
        assertApproxEqAbs(mk.priceUp(id), 0.7e18, 1e12);
        assertSolvent(id);

        uint256 id2 = mk.createMarket(REF, alice, START, LOWER, UPPER, SEED, 2000);
        m = mk.getMarket(id2);
        assertEq(m.poolUp, SEED);
        assertEq(m.poolDown, SEED * 2000 / 8000);
        (u, d) = mk.sharesOf(id2, alice);
        assertEq(u, 0);
        assertEq(d, SEED - m.poolDown);
        assertApproxEqAbs(mk.priceUp(id2), 0.2e18, 1e12);
        assertSolvent(id2);
    }

    // ------------------------------------------------------------------- buy

    function test_buy_matchesQuoteMovesPriceAccruesFee() public {
        uint256 id = create();
        (uint256 qShares, uint256 qFee) = mk.quoteBuy(id, UP, 100e6);
        assertEq(qFee, 1e6);
        uint256 shares = buyAs(alice, id, UP, 100e6);
        assertEq(shares, qShares);
        // 99 net into both pools, then UP taken out: a=1000,b=1000,n=99 ->
        // shares = 1000 + 99 - ceil(1000*1000/1099) = 1099 - 910 = 189.x
        assertApproxEqAbs(shares, 189_08e4, 1e4);
        assertGt(mk.priceUp(id), 0.5e18);
        BoundedVIMarkets.Market memory m = mk.getMarket(id);
        assertEq(m.fees, 1e6);
        assertEq(m.collateral, SEED + 99e6);
        (uint256 u,) = mk.sharesOf(id, alice);
        assertEq(u, shares);
        assertSolvent(id);
    }

    function test_buy_slippageAndZero() public {
        uint256 id = create();
        (uint256 q,) = mk.quoteBuy(id, DOWN, 50e6);
        vm.prank(alice);
        vm.expectRevert(BoundedVIMarkets.Slippage.selector);
        mk.buy(id, DOWN, 50e6, q + 1);
        vm.prank(alice);
        vm.expectRevert(BoundedVIMarkets.ZeroAmount.selector);
        mk.buy(id, DOWN, 0, 0);
        vm.prank(alice);
        vm.expectRevert(BoundedVIMarkets.NotOpen.selector);
        mk.buy(99, DOWN, 1e6, 0);
    }

    function test_buy_quoteIsZeroOnUnknownMarket() public view {
        (uint256 s, uint256 f) = mk.quoteBuy(7, UP, 1e6);
        assertEq(s, 0);
        assertEq(f, 0);
    }

    // ------------------------------------------------------------------ sell

    function test_sell_matchesQuoteAndChecks() public {
        uint256 id = create();
        uint256 shares = buyAs(alice, id, UP, 100e6);
        (uint256 qOut, uint256 qFee) = mk.quoteSell(id, UP, shares / 2);
        uint256 out = sellAs(alice, id, UP, shares / 2);
        assertEq(out, qOut);
        assertGt(qFee, 0);
        assertSolvent(id);

        vm.prank(alice);
        vm.expectRevert(BoundedVIMarkets.InsufficientShares.selector);
        mk.sell(id, UP, shares, 0);
        vm.prank(alice);
        vm.expectRevert(BoundedVIMarkets.Slippage.selector);
        mk.sell(id, UP, shares / 4, type(uint256).max);
        vm.prank(alice);
        vm.expectRevert(BoundedVIMarkets.ZeroAmount.selector);
        mk.sell(id, UP, 0, 0);
    }

    function test_roundTrip_losesAboutTwoFees() public {
        uint256 id = create();
        uint256 before = usdg.balanceOf(alice);
        uint256 shares = buyAs(alice, id, UP, 100e6);
        sellAs(alice, id, UP, shares);
        uint256 loss = before - usdg.balanceOf(alice);
        // 1% in, ~1% out of 99, plus rounding in the pool's favour.
        assertGe(loss, 1e6 + 0.98e6);
        assertLe(loss, 2e6 + 10);
        BoundedVIMarkets.Market memory m = mk.getMarket(id);
        // The pool is back to (about) where it started.
        assertApproxEqAbs(m.poolUp, SEED, 10);
        assertApproxEqAbs(m.poolDown, SEED, 10);
        assertSolvent(id);
    }

    function testFuzz_roundTripNeverProfits(uint96 invest) public {
        invest = uint96(bound(invest, 1, 5_000e6));
        uint256 id = create();
        uint256 before = usdg.balanceOf(alice);
        vm.prank(alice);
        try mk.buy(id, DOWN, invest, 0) returns (uint256 shares) {
            // A dust sell that would pay nothing reverts; that is fine too.
            vm.prank(alice);
            try mk.sell(id, DOWN, shares, 0) {} catch {}
        } catch {}
        assertLe(usdg.balanceOf(alice), before);
        assertSolvent(id);
    }

    // --------------------------------------------------------------- resolve

    function test_resolve_accessOnceAndBlocksTrading() public {
        uint256 id = create();
        vm.expectRevert(BoundedVIMarkets.NotOracle.selector);
        mk.resolve(id, UP, UPPER);
        vm.prank(oracle);
        vm.expectRevert(BoundedVIMarkets.NoSuchMarket.selector);
        mk.resolve(42, UP, UPPER);

        vm.prank(oracle);
        vm.expectEmit(true, true, true, true);
        emit BoundedVIMarkets.Resolved(id, UP, UPPER);
        mk.resolve(id, UP, UPPER);

        vm.prank(oracle);
        vm.expectRevert(BoundedVIMarkets.AlreadyResolved.selector);
        mk.resolve(id, DOWN, LOWER);

        vm.prank(alice);
        vm.expectRevert(BoundedVIMarkets.NotOpen.selector);
        mk.buy(id, UP, 1e6, 0);
        vm.prank(alice);
        vm.expectRevert(BoundedVIMarkets.NotOpen.selector);
        mk.sell(id, UP, 1, 0);
        (uint256 s,) = mk.quoteBuy(id, UP, 1e6);
        assertEq(s, 0);
    }

    function test_redeem_winnersOneToOneLosersNothing() public {
        uint256 id = create();
        uint256 aShares = buyAs(alice, id, UP, 200e6);
        uint256 bShares = buyAs(bob, id, DOWN, 50e6);
        assertGt(bShares, 0);

        vm.prank(alice);
        vm.expectRevert(BoundedVIMarkets.NotResolved.selector);
        mk.redeem(id);

        vm.prank(oracle);
        mk.resolve(id, UP, UPPER);

        uint256 aBefore = usdg.balanceOf(alice);
        vm.prank(alice);
        assertEq(mk.redeem(id), aShares);
        assertEq(usdg.balanceOf(alice) - aBefore, aShares);
        vm.prank(alice);
        assertEq(mk.redeem(id), 0);

        uint256 bBefore = usdg.balanceOf(bob);
        vm.prank(bob);
        assertEq(mk.redeem(id), 0);
        assertEq(usdg.balanceOf(bob), bBefore);

        // Pool's winning shares to the fee recipient; then only fees remain.
        uint256 swept = mk.sweepPool(id);
        BoundedVIMarkets.Market memory m = mk.getMarket(id);
        assertEq(m.collateral, 0);
        assertEq(swept, SEED + 200e6 * 99 / 100 + 50e6 * 99 / 100 - aShares);
        assertEq(usdg.balanceOf(address(mk)), m.fees);
        uint256 fees = mk.withdrawFees(id);
        assertEq(fees, 2e6 + 0.5e6);
        assertEq(usdg.balanceOf(address(mk)), 0);
    }

    function testFuzz_tradesResolveRedeemSweepLeavesNothing(uint256 seedRand, uint8 steps, bool upWins) public {
        uint256 id = create();
        steps = uint8(bound(steps, 1, 40));
        uint256 r = seedRand;
        for (uint256 i = 0; i < steps; i++) {
            r = uint256(keccak256(abi.encode(r, i)));
            address who = traders[r % 3];
            BoundedVIMarkets.Side side = (r >> 8) % 2 == 0 ? UP : DOWN;
            bool doBuy = (r >> 16) % 3 != 0;
            if (doBuy) {
                uint256 invest = ((r >> 24) % 500e6) + 1;
                vm.prank(who);
                try mk.buy(id, side, invest, 0) {} catch {}
            } else {
                (uint256 u, uint256 d) = mk.sharesOf(id, who);
                uint256 held = side == UP ? u : d;
                if (held > 0) {
                    uint256 amt = ((r >> 24) % held) + 1;
                    vm.prank(who);
                    try mk.sell(id, side, amt, 0) {} catch {}
                }
            }
            assertSolvent(id);
        }
        vm.prank(oracle);
        mk.resolve(id, upWins ? UP : DOWN, upWins ? UPPER : LOWER);
        for (uint256 i = 0; i < 3; i++) {
            vm.prank(traders[i]);
            mk.redeem(id);
        }
        mk.redeem(id); // the creator may hold nothing; must not revert
        mk.sweepPool(id);
        BoundedVIMarkets.Market memory m = mk.getMarket(id);
        assertEq(m.collateral, 0, "collateral left after everyone was paid");
        assertEq(usdg.balanceOf(address(mk)), m.fees, "balance != fees");
        mk.withdrawFees(id);
        assertEq(usdg.balanceOf(address(mk)), 0, "dust left in the contract");
    }

    // ----------------------------------------------------------------- pause

    function test_pause_blocksTradingNotSettlement() public {
        uint256 id = create();
        buyAs(alice, id, UP, 10e6);
        mk.pause();
        vm.expectRevert(Pausable.EnforcedPause.selector);
        create();
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        mk.buy(id, UP, 1e6, 0);
        vm.prank(alice);
        vm.expectRevert(Pausable.EnforcedPause.selector);
        mk.sell(id, UP, 1, 0);
        vm.prank(oracle);
        mk.resolve(id, UP, UPPER);
        vm.prank(alice);
        assertGt(mk.redeem(id), 0);
        mk.unpause();
        create();
    }

    // ----------------------------------------------------------------- owner

    function test_owner_feeCapAndAccess() public {
        vm.expectRevert(BoundedVIMarkets.FeeTooHigh.selector);
        mk.setFeeBps(501);
        mk.setFeeBps(500);
        assertEq(mk.feeBps(), 500);
        uint256 id = create();
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        mk.withdrawFees(id);
        vm.prank(alice);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, alice));
        mk.sweepPool(id);
        vm.expectRevert(BoundedVIMarkets.NotResolved.selector);
        mk.sweepPool(id);
        mk.setOracle(alice);
        assertEq(mk.oracle(), alice);
        vm.expectRevert(BoundedVIMarkets.ZeroAddress.selector);
        mk.setOracle(address(0));
        mk.setOperator(bob, true);
        vm.prank(bob);
        mk.createMarket(REF, bob, START, LOWER, UPPER, 1e6, 5000);
    }

    function test_oneUnitTradeCannotExtract() public {
        uint256 id = create();
        vm.prank(alice);
        vm.expectRevert(BoundedVIMarkets.ZeroAmount.selector);
        mk.buy(id, UP, 1, 0); // fee rounds up to the whole unit
        uint256 before = usdg.balanceOf(alice);
        uint256 shares = buyAs(alice, id, UP, 2);
        assertGe(shares, 1);
        // Selling the dust back pays nothing, so it reverts rather than
        // rounding in the seller's favour.
        vm.prank(alice);
        vm.expectRevert(BoundedVIMarkets.ZeroAmount.selector);
        mk.sell(id, UP, shares, 0);
        assertLe(usdg.balanceOf(alice), before);
        assertSolvent(id);
    }

    function test_views() public {
        uint256 a = create();
        uint256 b = create();
        buyAs(alice, a, UP, 10e6);
        buyAs(alice, b, DOWN, 10e6);
        uint256[] memory ids = new uint256[](2);
        ids[0] = a;
        ids[1] = b;
        uint256[2][] memory bal = mk.balancesOf(alice, ids);
        (uint256 u,) = mk.sharesOf(a, alice);
        (, uint256 d) = mk.sharesOf(b, alice);
        assertEq(bal[0][0], u);
        assertEq(bal[1][1], d);
        BoundedVIMarkets.Market[] memory ms = mk.getMarkets(ids);
        assertEq(ms.length, 2);
        assertEq(ms[0].ref, REF);
    }

    function test_mockUsdg() public {
        assertEq(usdg.decimals(), 6);
        vm.expectRevert(abi.encodeWithSelector(MockUSDG.MintTooLarge.selector, 10_000e6 + 1, 10_000e6));
        usdg.mint(alice, 10_000e6 + 1);
        usdg.mint(alice, 10_000e6);
    }
}
