// Position accounting shared by every view: the portfolio page and API,
// the leaderboard, the close modal and the trade panel. The database
// functions in supabase/009 apply the same rules when a position is
// actually closed, so what a view shows is what a close would pay.
//
// PnL is linear in the VI: size × (vi/entry − 1) × leverage, sign flipped
// for a short, and floored at −size. A position cannot lose more than was
// put in; when the mark reaches that floor the exchange closes it
// (liquidation) and the balance gets nothing back.

// Charged on the size of every open, then split: half to the account that
// created the market, half to the simulated treasury.
export const FEE_RATE = 0.01;
export const CREATOR_FEE_SHARE = 0.5;

export type Direction = 'long' | 'short';

export interface PnlInput {
  sizeUsd: number;
  entryVi: number;
  currentVi: number;
  direction: Direction;
  leverage: number;
}

export interface Pnl {
  pnlUsd: number;
  // Against the size put in: −100 is a full loss.
  pnlPercent: number;
  // The mark is at or past the floor; a close (or the next VI write) ends it.
  liquidated: boolean;
}

// Fractional move in the position's favour, before leverage.
function directional(p: { entryVi: number; currentVi: number; direction: Direction }) {
  const entry = p.entryVi || 1;
  const ratio = p.currentVi / entry;
  return p.direction === 'long' ? ratio - 1 : 1 - ratio;
}

export function positionPnl(p: PnlInput): Pnl {
  const raw = directional(p) * (p.leverage || 1);
  const liquidated = raw <= -1;
  const fraction = liquidated ? -1 : raw;
  return {
    pnlUsd: p.sizeUsd * fraction,
    pnlPercent: fraction * 100,
    liquidated,
  };
}

// The VI at which the position is liquidated: a move of 1/leverage against
// it. A 1× long goes at 0, a 1× short at twice its entry.
export function liquidationVi(entryVi: number, direction: Direction, leverage: number): number {
  const move = entryVi / (leverage || 1);
  return direction === 'long' ? Math.max(0, entryVi - move) : entryVi + move;
}

// Fee on an open, in whole cents, the way open_position() rounds it.
export function tradeFee(sizeUsd: number): number {
  return Math.round(sizeUsd * FEE_RATE * 100) / 100;
}
