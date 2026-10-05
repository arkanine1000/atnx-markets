// Off-chain mirror of programs/vi_rounds/src/math.rs, in BigInt, so the
// ticket can quote without a round trip and show the number the chain will
// produce. Must stay bit-for-bit in step with that file.
//
// The engine is Pennock's dynamic pari-mutuel market (2004), variant I with
// price function I: with money M and shares N per side, spending m on a side
// buys N_other · ln(1 + m/M_side) shares; at settlement a winner gets their
// net stake back plus shares · M_lose / N_win. Every step floors.

export const S = 1_000_000_000_000_000_000n; // 1e18
export const LN2 = 693_147_180_559_945_309n;
export const BPS = 10_000n;
export const MAX_RATIO = 1000n;

export type RoundSide = 'up' | 'down';

export function otherSide(side: RoundSide): RoundSide {
  return side === 'up' ? 'down' : 'up';
}

export class DpmError extends Error {
  constructor(public readonly code: 'overflow' | 'ratio' | 'zero_pool') {
    super(code);
  }
}

function leadingZeros128(v: bigint): number {
  // v in [1, 2^128).
  let n = 0;
  let bit = 1n << 127n;
  while (bit > v) {
    n++;
    bit >>= 1n;
  }
  return n;
}

// floor(ln(x / 1e18) · 1e18) for x ≥ 1e18.
export function lnFp(x: bigint): bigint {
  if (x < S) throw new DpmError('overflow');
  const q = x / S;
  const k = 127 - leadingZeros128(q);
  const y = x >> BigInt(k);
  const z = ((y - S) * S) / (y + S);
  const z2 = (z * z) / S;
  let term = z;
  let sum = z;
  let i = 3n;
  while (term > 1_000n) {
    term = (term * z2) / S;
    sum += term / i;
    i += 2n;
  }
  return BigInt(k) * LN2 + 2n * sum;
}

// Shares bought on one side by spending `net` (after fee).
export function sharesForSpend(nOther: bigint, mSide: bigint, net: bigint): bigint {
  if (mSide <= 0n || nOther <= 0n) throw new DpmError('zero_pool');
  if (net > MAX_RATIO * mSide) throw new DpmError('ratio');
  const x = ((mSide + net) * S) / mSide;
  const n = (nOther * lnFp(x)) / S;
  if (n > 0xffff_ffff_ffff_ffffn) throw new DpmError('overflow');
  return n;
}

export interface FeeSplit {
  fee: bigint;
  finder: bigint;
  platform: bigint;
  net: bigint;
}

function ceilDiv(a: bigint, b: bigint): bigint {
  return a === 0n ? 0n : (a - 1n) / b + 1n;
}

export function feeSplit(amount: bigint, feeBps: bigint, finderBps: bigint): FeeSplit {
  const fee = ceilDiv(amount * feeBps, BPS);
  const finder = (fee * finderBps) / BPS;
  return { fee, finder, platform: fee - finder, net: amount - fee };
}

// Shares a presale commit holds once the round opens: commit · total / pot.
export function presaleShares(commit: bigint, potSide: bigint, total: bigint): bigint {
  if (potSide <= 0n || commit <= 0n) return 0n;
  return (commit * total) / potSide;
}

// Price of one share on a side during the presale, as a number in [0, 1]:
// the pot share, which is also the live price the round opens at.
export function presalePrice(potUp: bigint, potDown: bigint, side: RoundSide): number | null {
  const total = potUp + potDown;
  if (total === 0n) return null;
  const pot = side === 'up' ? potUp : potDown;
  return Number((pot * 1_000_000n) / total) / 1_000_000;
}

export interface Pools {
  mUp: bigint;
  mDown: bigint;
  nUp: bigint;
  nDown: bigint;
}

// The market's probability of UP: M1·N1 / (M1·N1 + M2·N2).
export function mprUp(p: Pools): number {
  const a = p.mUp * p.nUp;
  const b = p.mDown * p.nDown;
  const den = a + b;
  if (den === 0n) return 0.5;
  return Number((a * 1_000_000n) / den) / 1_000_000;
}

export interface BuyQuote {
  fee: bigint;
  net: bigint;
  shares: bigint;
  after: Pools;
}

// A live buy: fee off the top, then the curve.
export function quoteBuy(p: Pools, side: RoundSide, amount: bigint, feeBps: bigint, finderBps: bigint): BuyQuote {
  if (amount <= 0n) return { fee: 0n, net: 0n, shares: 0n, after: p };
  const { fee, net } = feeSplit(amount, feeBps, finderBps);
  const mSide = side === 'up' ? p.mUp : p.mDown;
  const nOther = side === 'up' ? p.nDown : p.nUp;
  const shares = sharesForSpend(nOther, mSide, net);
  const after: Pools =
    side === 'up'
      ? { ...p, mUp: p.mUp + net, nUp: p.nUp + shares }
      : { ...p, mDown: p.mDown + net, nDown: p.nDown + shares };
  return { fee, net, shares, after };
}

// Payout to a winner: net stake back plus shares · M_lose / N_win.
export function payout(stakeWin: bigint, sharesWin: bigint, mLose: bigint, nWin: bigint): bigint {
  if (sharesWin === 0n) return stakeWin;
  if (nWin === 0n) throw new DpmError('zero_pool');
  return stakeWin + (sharesWin * mLose) / nWin;
}

export interface PositionLike {
  presaleUp: bigint;
  presaleDown: bigint;
  stakeUp: bigint;
  stakeDown: bigint;
  sharesUp: bigint;
  sharesDown: bigint;
}

export interface RoundLike extends Pools {
  presaleUp: bigint; // U, fixed at open
  presaleDown: bigint; // D
}

// What a position would be paid if `side` won at the current pools.
export function payoutIf(pos: PositionLike, r: RoundLike, side: RoundSide): bigint {
  const total = r.presaleUp + r.presaleDown;
  if (side === 'up') {
    const shares = presaleShares(pos.presaleUp, r.presaleUp, total) + pos.sharesUp;
    return payout(pos.presaleUp + pos.stakeUp, shares, r.mDown, r.nUp);
  }
  const shares = presaleShares(pos.presaleDown, r.presaleDown, total) + pos.sharesDown;
  return payout(pos.presaleDown + pos.stakeDown, shares, r.mUp, r.nDown);
}
