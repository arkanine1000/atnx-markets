import { test } from 'node:test';
import assert from 'node:assert/strict';
import { averageVi, fromE2, settleWindow, toE2, winnerOf } from './settle';

test('averageVi: no prints is null', () => {
  assert.equal(averageVi([]), null);
});

test('averageVi: plain mean, rounded to two decimals', () => {
  assert.equal(averageVi([{ vi: 100 }, { vi: 200 }]), 150);
  assert.equal(averageVi([{ vi: 1 }, { vi: 2 }, { vi: 2 }]), 1.67);
  assert.equal(averageVi([{ vi: 1 }, { vi: 1 }, { vi: 2 }]), 1.33);
  assert.equal(averageVi([{ vi: 412.345 }]), 412.35);
  assert.equal(averageVi([{ vi: 412.344 }]), 412.34);
});

test('winnerOf: UP at or above the target, a tie goes UP', () => {
  assert.equal(winnerOf(12345n, 12345n), 'up');
  assert.equal(winnerOf(12346n, 12345n), 'up');
  assert.equal(winnerOf(12344n, 12345n), 'down');
});

test('E2 round trips', () => {
  assert.equal(toE2(123.45), 12345n);
  assert.equal(toE2(0), 0n);
  assert.equal(toE2(1000), 100000n);
  assert.equal(toE2(0.1 + 0.2), 30n);
  assert.equal(fromE2(12345n), 123.45);
  for (const v of [0.01, 1.1, 99.99, 412.35, 1163.07, 5000]) assert.equal(fromE2(toE2(v)), v);
  assert.equal(winnerOf(toE2(averageVi([{ vi: 100 }, { vi: 100.01 }])!), toE2(100.01)), 'up');
  assert.throws(() => toE2(-1));
  assert.throws(() => toE2(Number.NaN));
});

test('settleWindow: [close − window, close]', () => {
  const close = new Date('2026-10-08T12:00:00Z');
  const w = settleWindow(close, 1800);
  assert.equal(w.from.toISOString(), '2026-10-08T11:30:00.000Z');
  assert.equal(w.to.toISOString(), '2026-10-08T12:00:00.000Z');
  assert.notEqual(w.to, close);
  const fast = settleWindow(close, 900);
  assert.equal(fast.from.toISOString(), '2026-10-08T11:45:00.000Z');
});
