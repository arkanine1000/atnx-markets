import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyPrints, type Print, type StreakState } from './keeper';

const B = { lower: 20, upper: 500 };
const fresh: StreakState = { cursor: 0, streakSide: null, streakCount: 0 };
const ps = (...vis: number[]): Print[] => vis.map((vi, i) => ({ id: i + 1, vi }));

test('two prints past the bound then a dip resets', () => {
  const r = applyPrints(fresh, ps(510, 520, 400), B);
  assert.equal(r.touch, null);
  assert.deepEqual(r.state, { cursor: 3, streakSide: null, streakCount: 0 });
});

test('three prints at or past the upper bound resolve UP, equality counts', () => {
  const r = applyPrints(fresh, ps(100, 500, 501, 500), B);
  assert.ok(r.touch);
  assert.equal(r.touch.side, 'up');
  assert.equal(r.touch.vi, 500);
  assert.deepEqual(r.touch.printIds, [2, 3, 4]);
  assert.equal(r.state.cursor, 4);
});

test('a touch stops consuming further prints', () => {
  const r = applyPrints(fresh, ps(600, 600, 600, 10, 10, 10), B);
  assert.equal(r.touch?.side, 'up');
  assert.equal(r.state.cursor, 3);
});

test('a lower bound of 0 needs the VI to print 0', () => {
  const r = applyPrints(fresh, ps(0.5, 0.1, 0.01), { lower: 0, upper: 50 });
  assert.equal(r.touch, null);
  const z = applyPrints(fresh, ps(0, 0, 0), { lower: 0, upper: 50 });
  assert.equal(z.touch?.side, 'down');
});

test('alternating sides never resolve', () => {
  const r = applyPrints(fresh, ps(600, 10, 600, 10, 600, 10), B);
  assert.equal(r.touch, null);
  assert.equal(r.state.streakSide, 'down');
  assert.equal(r.state.streakCount, 1);
});

test('the streak continues across runs through the stored state', () => {
  const first = applyPrints(fresh, ps(15, 12), B);
  assert.equal(first.state.streakCount, 2);
  const second = applyPrints(first.state, [{ id: 3, vi: 19 }], B);
  assert.equal(second.touch?.side, 'down');
});

test('prints at or before the cursor are ignored; the cursor advances with no touch', () => {
  const r = applyPrints({ cursor: 2, streakSide: 'up', streakCount: 2 }, ps(600, 600, 100), B);
  assert.equal(r.touch, null);
  assert.equal(r.state.cursor, 3);
  assert.equal(r.state.streakCount, 0);
});

test('a 500-print batch resolves once at the third print past the bound', () => {
  const vis = Array.from({ length: 500 }, (_, i) => (i < 497 ? 100 : 700));
  const r = applyPrints(fresh, ps(...vis), B);
  assert.equal(r.touch?.side, 'up');
  assert.equal(r.state.cursor, 500);
});

test('need is configurable', () => {
  assert.equal(applyPrints(fresh, ps(600), B, 1).touch?.side, 'up');
  assert.equal(applyPrints(fresh, ps(600, 600, 600, 600), B, 5).touch, null);
});
