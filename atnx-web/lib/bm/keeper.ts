import type { BmSide } from '@/lib/supabase/database-bm';

// The touch rule, as a pure function so it can be tested on fixtures and
// run dry against the live history. A market resolves when `need`
// consecutive VI prints sit at or past one bound. Any print strictly
// inside the bounds resets the run; a print past the other bound starts
// a new run of one on that side. Both the five-minute and the hourly
// writes are prints.
//
// What this does not do (documented open decision): a market whose lower
// bound is 0 only resolves DOWN when the VI actually prints 0, which the
// index does only when every answering source reads zero. A "deemed
// dead" rule (for example, no source has answered for seven days) is
// not implemented.

export interface Print {
  id: number;
  vi: number;
}

export interface StreakState {
  cursor: number;
  streakSide: BmSide | null;
  streakCount: number;
}

export interface Touch {
  side: BmSide;
  vi: number;
  printIds: number[];
}

export interface ApplyResult {
  state: StreakState;
  touch: Touch | null;
}

export function sideOf(vi: number, bounds: { lower: number; upper: number }): BmSide | null {
  if (vi >= bounds.upper) return 'up';
  if (vi <= bounds.lower) return 'down';
  return null;
}

export function applyPrints(
  start: StreakState,
  prints: Print[],
  bounds: { lower: number; upper: number },
  need = 3
): ApplyResult {
  let side = start.streakSide;
  let count = start.streakCount;
  let cursor = start.cursor;
  const ids: number[] = [];
  for (const p of prints) {
    if (p.id <= cursor) continue;
    cursor = p.id;
    const s = sideOf(p.vi, bounds);
    if (s === null) {
      side = null;
      count = 0;
      ids.length = 0;
      continue;
    }
    if (s === side) {
      count += 1;
      ids.push(p.id);
    } else {
      side = s;
      count = 1;
      ids.length = 0;
      ids.push(p.id);
    }
    if (count >= need) {
      return {
        state: { cursor, streakSide: side, streakCount: count },
        touch: { side, vi: p.vi, printIds: ids.slice(-need) },
      };
    }
  }
  return { state: { cursor, streakSide: side, streakCount: count }, touch: null };
}
