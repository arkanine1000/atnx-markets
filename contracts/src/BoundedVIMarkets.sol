// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable, Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// @title Bounded VI markets
/// @notice Two-outcome markets on the ATNX Virality Index (VI). Each market
///         has an upper and a lower bound fixed at creation. It resolves
///         only when the oracle reports that the VI touched a bound: UP pays
///         1 USDG per share at the upper bound, DOWN at the lower. Until
///         then UP and DOWN trade against a fixed-product market maker
///         seeded by the operator.
///
///         Accounting. One UP plus one DOWN is a complete set and is backed
///         by exactly 1 USDG of `collateral`. For each side, the pool's
///         shares plus every holder's shares equal `collateral`, so after
///         resolution every winning share can be paid in full with nothing
///         left over: no leverage, no liquidation, no house counterparty.
///
///         Buy: the investment (less fee) mints that many complete sets into
///         the pool, then the buyer takes shares of the chosen side out of
///         the pool, as many as keep poolUp * poolDown from falling (the
///         Gnosis FixedProductMarketMaker buy, two outcomes).
///
///         Sell: the seller's shares go back into the pool, then the pool
///         burns as many complete sets as keep the product from falling and
///         pays the seller 1 USDG per set (less fee). This is the same
///         invariant as the Gnosis sell but solved for an exact share count
///         so "sell everything" is one call. Rounding always favours the
///         pool.
///
///         VI values are integers with two decimals (E2): 123.45 is 12345.
contract BoundedVIMarkets is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    enum Status {
        None,
        Open,
        Resolved
    }

    enum Side {
        Up,
        Down
    }

    struct Market {
        uint128 poolUp;
        uint128 poolDown;
        uint128 collateral; // USDG backing the outstanding complete sets
        uint128 fees; // accrued fees, withdrawable by the owner
        uint64 startViE2;
        uint64 lowerE2;
        uint64 upperE2;
        uint64 resolvedViE2;
        uint32 createdAt;
        uint32 resolvedAt;
        Status status;
        Side winner;
        address creator;
        bytes32 ref; // off-chain reference (ATNX market uuid + roll counter)
    }

    uint256 public constant BPS = 10_000;
    uint16 public constant MAX_FEE_BPS = 500;

    IERC20 public immutable usdg;
    address public oracle;
    address public feeRecipient;
    uint16 public feeBps = 100;
    uint256 public marketCount;

    mapping(address => bool) public operators;
    mapping(uint256 => Market) internal _markets;
    mapping(uint256 => mapping(address => uint256[2])) internal _shares;

    event MarketCreated(
        uint256 indexed id,
        bytes32 indexed ref,
        address indexed creator,
        uint64 startViE2,
        uint64 lowerE2,
        uint64 upperE2,
        uint256 seed,
        uint16 upBps
    );
    event Bought(
        uint256 indexed id,
        address indexed trader,
        Side side,
        uint256 invest,
        uint256 fee,
        uint256 shares,
        uint128 poolUp,
        uint128 poolDown
    );
    event Sold(
        uint256 indexed id,
        address indexed trader,
        Side side,
        uint256 shares,
        uint256 payout,
        uint256 fee,
        uint128 poolUp,
        uint128 poolDown
    );
    event Resolved(uint256 indexed id, Side winner, uint64 viE2);
    event Redeemed(uint256 indexed id, address indexed holder, uint256 amount);
    event FeesWithdrawn(uint256 indexed id, address indexed to, uint256 amount);
    event PoolSwept(uint256 indexed id, address indexed to, uint256 amount);
    event OracleSet(address oracle);
    event OperatorSet(address operator, bool allowed);
    event FeeRecipientSet(address feeRecipient);
    event FeeBpsSet(uint16 feeBps);

    error NotOperator();
    error NotOracle();
    error NoSuchMarket();
    error NotOpen();
    error AlreadyResolved();
    error NotResolved();
    error BadBounds();
    error BadUpBps();
    error ZeroAmount();
    error Slippage();
    error InsufficientShares();
    error FeeTooHigh();
    error ZeroAddress();

    modifier onlyOperator() {
        if (!operators[msg.sender]) revert NotOperator();
        _;
    }

    modifier onlyOracle() {
        if (msg.sender != oracle) revert NotOracle();
        _;
    }

    constructor(IERC20 usdg_, address oracle_, address feeRecipient_) Ownable(msg.sender) {
        if (address(usdg_) == address(0) || oracle_ == address(0) || feeRecipient_ == address(0)) {
            revert ZeroAddress();
        }
        usdg = usdg_;
        oracle = oracle_;
        feeRecipient = feeRecipient_;
        operators[msg.sender] = true;
        emit OperatorSet(msg.sender, true);
    }

    // ------------------------------------------------------------------
    // Market lifecycle
    // ------------------------------------------------------------------

    /// @notice Opens a market. Pulls `seed` USDG from the operator and
    ///         mints that many complete sets into the pool. With
    ///         `upBps = 5000` both pools hold `seed`. Any other opening
    ///         probability keeps the larger pool at `seed`, shrinks the
    ///         other to match the price, and hands the shares taken out to
    ///         `creator` (the Gnosis distribution hint).
    function createMarket(
        bytes32 ref,
        address creator,
        uint64 startViE2,
        uint64 lowerE2,
        uint64 upperE2,
        uint256 seed,
        uint16 upBps
    ) external onlyOperator whenNotPaused nonReentrant returns (uint256 id) {
        if (!(lowerE2 < startViE2 && startViE2 < upperE2)) revert BadBounds();
        if (upBps < 500 || upBps > 9500) revert BadUpBps();
        if (seed == 0) revert ZeroAmount();
        if (creator == address(0)) creator = msg.sender;

        usdg.safeTransferFrom(msg.sender, address(this), seed);

        id = ++marketCount;
        Market storage m = _markets[id];
        m.status = Status.Open;
        m.ref = ref;
        m.creator = creator;
        m.startViE2 = startViE2;
        m.lowerE2 = lowerE2;
        m.upperE2 = upperE2;
        m.createdAt = uint32(block.timestamp);
        m.collateral = _u128(seed);

        // priceUp = poolDown / (poolUp + poolDown) = upBps / BPS
        if (upBps == 5000) {
            m.poolUp = _u128(seed);
            m.poolDown = _u128(seed);
        } else if (upBps > 5000) {
            // UP is likelier, so UP is dearer: fewer UP in the pool.
            uint256 poolUp = Math.mulDiv(seed, BPS - upBps, upBps);
            m.poolDown = _u128(seed);
            m.poolUp = _u128(poolUp);
            _shares[id][creator][uint256(Side.Up)] += seed - poolUp;
        } else {
            uint256 poolDown = Math.mulDiv(seed, upBps, BPS - upBps);
            m.poolUp = _u128(seed);
            m.poolDown = _u128(poolDown);
            _shares[id][creator][uint256(Side.Down)] += seed - poolDown;
        }

        emit MarketCreated(id, ref, creator, startViE2, lowerE2, upperE2, seed, upBps);
    }

    /// @notice Settles a market. Only the oracle, only once. Allowed while
    ///         paused so a pause never traps funds.
    function resolve(uint256 id, Side winner, uint64 viE2) external onlyOracle {
        Market storage m = _markets[id];
        if (m.status == Status.None) revert NoSuchMarket();
        if (m.status == Status.Resolved) revert AlreadyResolved();
        m.status = Status.Resolved;
        m.winner = winner;
        m.resolvedViE2 = viE2;
        m.resolvedAt = uint32(block.timestamp);
        emit Resolved(id, winner, viE2);
    }

    // ------------------------------------------------------------------
    // Trading
    // ------------------------------------------------------------------

    /// @notice Buys `side` shares with `invest` USDG. Reverts if fewer than
    ///         `minShares` would come out.
    function buy(uint256 id, Side side, uint256 invest, uint256 minShares)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 shares)
    {
        Market storage m = _markets[id];
        if (m.status != Status.Open) revert NotOpen();
        if (invest == 0) revert ZeroAmount();

        (uint256 fee, uint256 net, uint256 newThis, uint256 newOther) = _buyMath(m, side, invest);
        shares = _poolOf(m, side) + net - newThis;
        if (shares == 0) revert ZeroAmount();
        if (shares < minShares) revert Slippage();

        usdg.safeTransferFrom(msg.sender, address(this), invest);

        m.collateral += _u128(net);
        m.fees += _u128(fee);
        _setPools(m, side, newThis, newOther);
        _shares[id][msg.sender][uint256(side)] += shares;

        emit Bought(id, msg.sender, side, invest, fee, shares, m.poolUp, m.poolDown);
    }

    /// @notice Sells exactly `shares` of `side`. Reverts if the payout
    ///         (after fee) would be below `minReturn`.
    function sell(uint256 id, Side side, uint256 shares, uint256 minReturn)
        external
        whenNotPaused
        nonReentrant
        returns (uint256 payout)
    {
        Market storage m = _markets[id];
        if (m.status != Status.Open) revert NotOpen();
        if (shares == 0) revert ZeroAmount();
        uint256 held = _shares[id][msg.sender][uint256(side)];
        if (held < shares) revert InsufficientShares();

        (uint256 burned, uint256 fee, uint256 newThis, uint256 newOther) = _sellMath(m, side, shares);
        payout = burned - fee;
        if (burned == 0) revert ZeroAmount();
        if (payout < minReturn) revert Slippage();

        _shares[id][msg.sender][uint256(side)] = held - shares;
        m.collateral -= _u128(burned);
        m.fees += _u128(fee);
        _setPools(m, side, newThis, newOther);

        usdg.safeTransfer(msg.sender, payout);

        emit Sold(id, msg.sender, side, shares, payout, fee, m.poolUp, m.poolDown);
    }

    /// @notice Pays 1 USDG per winning share after resolution. Allowed
    ///         while paused.
    function redeem(uint256 id) external nonReentrant returns (uint256 amount) {
        Market storage m = _markets[id];
        if (m.status != Status.Resolved) revert NotResolved();
        amount = _shares[id][msg.sender][uint256(m.winner)];
        if (amount == 0) return 0;
        _shares[id][msg.sender][uint256(m.winner)] = 0;
        m.collateral -= _u128(amount);
        usdg.safeTransfer(msg.sender, amount);
        emit Redeemed(id, msg.sender, amount);
    }

    // ------------------------------------------------------------------
    // Views
    // ------------------------------------------------------------------

    function quoteBuy(uint256 id, Side side, uint256 invest)
        external
        view
        returns (uint256 shares, uint256 fee)
    {
        Market storage m = _markets[id];
        if (m.status != Status.Open || invest == 0) return (0, 0);
        uint256 net;
        uint256 newThis;
        (fee, net, newThis,) = _buyMath(m, side, invest);
        shares = _poolOf(m, side) + net - newThis;
    }

    function quoteSell(uint256 id, Side side, uint256 shares)
        external
        view
        returns (uint256 payout, uint256 fee)
    {
        Market storage m = _markets[id];
        if (m.status != Status.Open || shares == 0) return (0, 0);
        uint256 burned;
        (burned, fee,,) = _sellMath(m, side, shares);
        payout = burned - fee;
    }

    /// @notice Price of one UP share in USDG, 18 decimals. DOWN is 1e18 minus this.
    function priceUp(uint256 id) external view returns (uint256) {
        Market storage m = _markets[id];
        uint256 total = uint256(m.poolUp) + m.poolDown;
        if (total == 0) return 0;
        return Math.mulDiv(m.poolDown, 1e18, total);
    }

    function getMarket(uint256 id) external view returns (Market memory) {
        return _markets[id];
    }

    function getMarkets(uint256[] calldata ids) external view returns (Market[] memory out) {
        out = new Market[](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            out[i] = _markets[ids[i]];
        }
    }

    function sharesOf(uint256 id, address holder) external view returns (uint256 up, uint256 down) {
        up = _shares[id][holder][uint256(Side.Up)];
        down = _shares[id][holder][uint256(Side.Down)];
    }

    function balancesOf(address holder, uint256[] calldata ids)
        external
        view
        returns (uint256[2][] memory out)
    {
        out = new uint256[2][](ids.length);
        for (uint256 i = 0; i < ids.length; i++) {
            out[i] = _shares[ids[i]][holder];
        }
    }

    // ------------------------------------------------------------------
    // Owner
    // ------------------------------------------------------------------

    function setOracle(address oracle_) external onlyOwner {
        if (oracle_ == address(0)) revert ZeroAddress();
        oracle = oracle_;
        emit OracleSet(oracle_);
    }

    function setOperator(address operator, bool allowed) external onlyOwner {
        operators[operator] = allowed;
        emit OperatorSet(operator, allowed);
    }

    function setFeeRecipient(address to) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        feeRecipient = to;
        emit FeeRecipientSet(to);
    }

    function setFeeBps(uint16 bps) external onlyOwner {
        if (bps > MAX_FEE_BPS) revert FeeTooHigh();
        feeBps = bps;
        emit FeeBpsSet(bps);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    function withdrawFees(uint256 id) external onlyOwner nonReentrant returns (uint256 amount) {
        Market storage m = _markets[id];
        if (m.status == Status.None) revert NoSuchMarket();
        amount = m.fees;
        if (amount == 0) return 0;
        m.fees = 0;
        usdg.safeTransfer(feeRecipient, amount);
        emit FeesWithdrawn(id, feeRecipient, amount);
    }

    /// @notice After resolution, the pool's own winning shares are what the
    ///         seed is worth; they go to the fee recipient. Losing shares
    ///         are worthless and stay where they are.
    function sweepPool(uint256 id) external onlyOwner nonReentrant returns (uint256 amount) {
        Market storage m = _markets[id];
        if (m.status != Status.Resolved) revert NotResolved();
        amount = _poolOf(m, m.winner);
        if (amount == 0) return 0;
        if (m.winner == Side.Up) m.poolUp = 0;
        else m.poolDown = 0;
        m.collateral -= _u128(amount);
        usdg.safeTransfer(feeRecipient, amount);
        emit PoolSwept(id, feeRecipient, amount);
    }

    // ------------------------------------------------------------------
    // Math
    // ------------------------------------------------------------------

    /// @dev Gnosis FPMM buy, two outcomes. `a` is the pool of the side
    ///      bought, `b` the other. After minting `net` sets the buyer takes
    ///      `a + net - ceil(a*b/(b+net))` shares, leaving the product at or
    ///      above `a*b`.
    function _buyMath(Market storage m, Side side, uint256 invest)
        internal
        view
        returns (uint256 fee, uint256 net, uint256 newThis, uint256 newOther)
    {
        fee = Math.mulDiv(invest, feeBps, BPS, Math.Rounding.Ceil);
        net = invest - fee;
        uint256 a = _poolOf(m, side);
        uint256 b = _poolOf(m, _other(side));
        newOther = b + net;
        newThis = Math.mulDiv(a, b, newOther, Math.Rounding.Ceil);
    }

    /// @dev Exact-shares sell. The seller's `s` shares join pool `a`; the
    ///      pool then burns `r` complete sets such that
    ///      (a + s - r) * (b - r) >= a * b, with `r` as large as possible:
    ///      the smaller root of r^2 - (a+b+s) r + s*b = 0, rounded down.
    function _sellMath(Market storage m, Side side, uint256 s)
        internal
        view
        returns (uint256 burned, uint256 fee, uint256 newThis, uint256 newOther)
    {
        uint256 a = _poolOf(m, side);
        uint256 b = _poolOf(m, _other(side));
        uint256 sum = a + b + s;
        uint256 disc = sum * sum - 4 * s * b;
        uint256 root = Math.sqrt(disc, Math.Rounding.Ceil);
        burned = (sum - root) / 2;
        // Guard the invariant against the last unit of rounding.
        while (burned > 0 && (a + s - burned) * (b - burned) < a * b) {
            burned--;
        }
        fee = Math.mulDiv(burned, feeBps, BPS, Math.Rounding.Ceil);
        newThis = a + s - burned;
        newOther = b - burned;
    }

    function _poolOf(Market storage m, Side side) internal view returns (uint256) {
        return side == Side.Up ? m.poolUp : m.poolDown;
    }

    function _setPools(Market storage m, Side side, uint256 thisPool, uint256 otherPool) internal {
        if (side == Side.Up) {
            m.poolUp = _u128(thisPool);
            m.poolDown = _u128(otherPool);
        } else {
            m.poolDown = _u128(thisPool);
            m.poolUp = _u128(otherPool);
        }
    }

    function _other(Side side) internal pure returns (Side) {
        return side == Side.Up ? Side.Down : Side.Up;
    }

    function _u128(uint256 x) internal pure returns (uint128) {
        return SafeCast128.toUint128(x);
    }
}

library SafeCast128 {
    error Overflow();

    function toUint128(uint256 x) internal pure returns (uint128) {
        if (x > type(uint128).max) revert Overflow();
        return uint128(x);
    }
}
