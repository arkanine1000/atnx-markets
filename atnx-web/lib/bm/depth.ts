import { BPS, type Pools, type Side } from './fpmm';

// The order book a fixed-product pool implies. There are no resting
// orders: at each price level the curve will sell (ask) or buy (bid) a
// number of shares before the marginal price moves past that level.
//
// Buying `side` with net collateral n moves its pool from (a, b) to
// (ab/(b+n), b+n), and the marginal price of `side` becomes
//   P = (b+n)² / (ab + (b+n)²)
// so the net collateral that takes the price to P is n = D − b with
//   D = sqrt(P·ab / (1 − P)),
// and the shares bought on the way are a + n − ab/D. Bids for `side` at
// price P are the asks for the other side at 1 − P: selling one UP is the
// same trade as buying one DOWN and merging the set.

export interface Level {
  price: number; // 0..1, the level's marginal price for `side`
  shares: number; // shares available at this level (not cumulative)
  total: number; // cumulative USDG from the mid to this level, fee included
  cumShares: number;
}

export interface Depth {
  mid: number; // marginal price of `side` now
  asks: Level[]; // ascending price, away from the mid
  bids: Level[]; // descending price, away from the mid
}

function pool(p: Pools, side: Side): [number, number] {
  return side === 'up' ? [Number(p.poolUp), Number(p.poolDown)] : [Number(p.poolDown), Number(p.poolUp)];
}

// Asks for `side`: cumulative shares and gross cost up to each price level.
function askLadder(p: Pools, side: Side, feeBps: bigint, step: number, levels: number): Level[] {
  const [a, b] = pool(p, side);
  if (a <= 0 || b <= 0) return [];
  const mid = b / (a + b);
  const fee = Number(feeBps) / Number(BPS);
  const out: Level[] = [];
  let prevShares = 0;
  // Start at the next whole step above the mid.
  let price = Math.floor(mid / step + 1e-9) * step + step;
  for (let i = 0; i < levels && price < 1; i++, price += step) {
    const D = Math.sqrt((price * a * b) / (1 - price));
    const n = D - b;
    if (n <= 0) continue;
    const cumShares = a + n - (a * b) / D;
    const shares = cumShares - prevShares;
    prevShares = cumShares;
    out.push({ price, shares, total: n / (1 - fee), cumShares });
  }
  return out;
}

export function impliedDepth(p: Pools, side: Side, feeBps: bigint, step = 0.01, levels = 12): Depth {
  const [a, b] = pool(p, side);
  const mid = a + b > 0 ? b / (a + b) : 0.5;
  const asks = askLadder(p, side, feeBps, step, levels);
  const other: Side = side === 'up' ? 'down' : 'up';
  const bids = askLadder(p, other, feeBps, step, levels).map((l) => ({ ...l, price: 1 - l.price }));
  return { mid, asks, bids };
}
