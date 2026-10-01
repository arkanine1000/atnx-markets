// Off-chain mirror of the contract's market-maker math, in bigint, so the
// ticket can quote without a round trip and show the same number the
// chain will. Must stay in step with contracts/src/BoundedVIMarkets.sol.

export const BPS = 10_000n;

export type Side = 'up' | 'down';

export interface Pools {
  poolUp: bigint;
  poolDown: bigint;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

function ceilSqrt(n: bigint): bigint {
  if (n < 2n) return n;
  // Newton on integers; floor sqrt, then bump if not exact.
  let x = BigInt(Math.floor(Math.sqrt(Number(n))));
  // Correct the float seed.
  while (x * x > n) x -= 1n;
  while ((x + 1n) * (x + 1n) <= n) x += 1n;
  return x * x === n ? x : x + 1n;
}

export function pool(p: Pools, side: Side): bigint {
  return side === 'up' ? p.poolUp : p.poolDown;
}

export function other(side: Side): Side {
  return side === 'up' ? 'down' : 'up';
}

export interface BuyQuote {
  fee: bigint;
  net: bigint;
  shares: bigint;
  after: Pools;
}

// Gnosis FPMM buy, two outcomes: mint `net` sets, take shares of `side`
// out so that the product does not fall.
export function quoteBuy(p: Pools, side: Side, invest: bigint, feeBps: bigint): BuyQuote {
  if (invest <= 0n) return { fee: 0n, net: 0n, shares: 0n, after: p };
  const fee = ceilDiv(invest * feeBps, BPS);
  const net = invest - fee;
  const a = pool(p, side);
  const b = pool(p, other(side));
  const newOther = b + net;
  const newThis = ceilDiv(a * b, newOther);
  const shares = a + net - newThis;
  const after: Pools = side === 'up' ? { poolUp: newThis, poolDown: newOther } : { poolUp: newOther, poolDown: newThis };
  return { fee, net, shares, after };
}

export interface SellQuote {
  burned: bigint;
  fee: bigint;
  payout: bigint;
  after: Pools;
}

// Exact-shares sell: the shares join the pool, then the pool burns as many
// complete sets as keep (a + s - r)(b - r) >= a*b.
export function quoteSell(p: Pools, side: Side, shares: bigint, feeBps: bigint): SellQuote {
  if (shares <= 0n) return { burned: 0n, fee: 0n, payout: 0n, after: p };
  const a = pool(p, side);
  const b = pool(p, other(side));
  const sum = a + b + shares;
  const disc = sum * sum - 4n * shares * b;
  const root = ceilSqrt(disc);
  let burned = (sum - root) / 2n;
  while (burned > 0n && (a + shares - burned) * (b - burned) < a * b) burned -= 1n;
  const fee = ceilDiv(burned * feeBps, BPS);
  const payout = burned - fee;
  const newThis = a + shares - burned;
  const newOther = b - burned;
  const after: Pools = side === 'up' ? { poolUp: newThis, poolDown: newOther } : { poolUp: newOther, poolDown: newThis };
  return { burned, fee, payout, after };
}

// Price of one UP share in USDG, as a plain number in [0, 1].
export function priceUp(p: Pools): number {
  const total = p.poolUp + p.poolDown;
  if (total === 0n) return 0;
  return Number((p.poolDown * 1_000_000n) / total) / 1_000_000;
}

export function price(p: Pools, side: Side): number {
  const up = priceUp(p);
  return side === 'up' ? up : 1 - up;
}
