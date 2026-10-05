import { test } from 'node:test';
import assert from 'node:assert/strict';
import { averageVi, fromE2, settleWindow, toE2, winnerOf } from './settle';
import { newSeriesRef, refForSeries, refFromHex, refToHex } from './sol-shared';

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

// ------------------------------------------------------------ references

const UUID = '0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0';

test('refForSeries: 32 bytes, uuid in 0–15, fast flag at 16, zeros 17–23', () => {
  const ref = refForSeries(UUID, true, 0x01020304050607);
  assert.equal(ref.length, 32);
  assert.equal(refToHex(ref.slice(0, 16)), UUID.replace(/-/g, ''));
  assert.equal(ref[16], 1);
  assert.deepEqual([...ref.slice(17, 24)], [0, 0, 0, 0, 0, 0, 0]);
  assert.equal(refForSeries(UUID, false)[16], 0);
});

test('refForSeries: nonce at 24–31, big-endian; default 0', () => {
  assert.deepEqual([...refForSeries(UUID, false, 0x01020304050607).slice(24)], [0, 1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual([...refForSeries(UUID, false, 1_760_000_000).slice(24)], [0, 0, 0, 0, 0x68, 0xe7, 0x78, 0x00]);
  assert.deepEqual([...refForSeries(UUID, false).slice(24)], [0, 0, 0, 0, 0, 0, 0, 0]);
  const bytes = Uint8Array.from([9, 8, 7, 6, 5, 4, 3, 2]);
  assert.deepEqual([...refForSeries(UUID, false, bytes).slice(24)], [...bytes]);
  assert.throws(() => refForSeries(UUID, false, -1));
  assert.throws(() => refForSeries(UUID, false, new Uint8Array(7)));
  assert.throws(() => refForSeries('not-a-uuid', false));
});

test('refToHex / refFromHex round trip', () => {
  const ref = refForSeries(UUID, true, 1_760_000_000);
  const hex = refToHex(ref);
  assert.match(hex, /^[0-9a-f]{64}$/);
  assert.deepEqual(refFromHex(hex), ref);
  assert.deepEqual(refFromHex(`0x${hex.toUpperCase()}`), ref);
});

test('newSeriesRef: the nonce is unix seconds, so starts a second apart differ', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_760_000_000_500 });
  const a = newSeriesRef(UUID, false);
  t.mock.timers.tick(1000);
  const b = newSeriesRef(UUID, false);
  assert.deepEqual(a, refForSeries(UUID, false, 1_760_000_000));
  assert.notEqual(refToHex(a), refToHex(b));
  assert.deepEqual(a.slice(0, 24), b.slice(0, 24));
});
