// The settlement rule of a VI round, as pure functions. A round settles
// on the plain mean of the VI prints recorded in the last `window`
// seconds before its close, rounded to two decimals; UP wins when that
// average is at or above the target (the VI at the open), so a tie goes
// UP. The program does the same comparison on chain with the E2 integers
// (123.45 → 12345) the keeper posts.

export type RoundWinner = 'up' | 'down';

export function averageVi(prints: Array<{ vi: number }>): number | null {
  if (prints.length === 0) return null;
  let sum = 0;
  for (const p of prints) sum += Number(p.vi);
  return Math.round((sum / prints.length) * 100) / 100;
}

export function toE2(vi: number): bigint {
  if (!Number.isFinite(vi) || vi < 0) throw new Error(`bad VI ${vi}`);
  return BigInt(Math.round(vi * 100));
}

export function fromE2(e2: bigint): number {
  return Number(e2) / 100;
}

export function winnerOf(settleE2: bigint, targetE2: bigint): RoundWinner {
  return settleE2 >= targetE2 ? 'up' : 'down';
}

// Both ends inclusive: prints recorded in [closeAt − window, closeAt].
export function settleWindow(closeAt: Date, windowSecs: number): { from: Date; to: Date } {
  return { from: new Date(closeAt.getTime() - windowSecs * 1000), to: new Date(closeAt.getTime()) };
}
