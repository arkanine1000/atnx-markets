// The bounds of a bounded VI market, from the design doc ("ATNX devnet
// market design: bounded VI markets", 2026-09-30). One multiplier m shrinks
// as the starting VI grows: wide for small VIs, tight for large ones.
//
//   m     = min(5, max(1.2, 1 + 4 * (100 / vi) ^ 1.25))
//   upper = vi * m
//   lower = vi / m
//
// Both are rounded to two significant figures so they read cleanly on a
// ticket; a lower bound under 5 becomes 0. The constants are fitted to
// three example markets (VI 10, 100, 1000), not to data. Tuning them is
// one of the doc's open decisions, once VI history is exported.

export const BOUNDS_CAP = 5;
export const BOUNDS_FLOOR = 1.2;
export const BOUNDS_EXPONENT = 1.25;
export const BOUNDS_ZERO_CUTOFF = 5;

export interface Bounds {
  lower: number;
  upper: number;
  multiplier: number;
}

const round2sf = (x: number) => Number(x.toPrecision(2));

export function multiplier(vi: number): number {
  return Math.min(BOUNDS_CAP, Math.max(BOUNDS_FLOOR, 1 + 4 * Math.pow(100 / vi, BOUNDS_EXPONENT)));
}

export function bounds(vi: number): Bounds {
  if (!Number.isFinite(vi) || vi <= 0) throw new Error('bounds: the starting VI must be positive');
  const m = multiplier(vi);
  const rawLower = vi / m;
  const lower = rawLower < BOUNDS_ZERO_CUTOFF ? 0 : round2sf(rawLower);
  return { lower, upper: round2sf(vi * m), multiplier: m };
}

// The contract stores VI values as integers with two decimals (E2), so a
// VI of 123.456 is 12346. Bounds and prints go through the same function
// so a comparison on-chain and off-chain can never disagree by rounding.
export function toE2(vi: number): bigint {
  return BigInt(Math.round(vi * 100));
}

export function fromE2(e2: bigint | number): number {
  return Number(e2) / 100;
}
