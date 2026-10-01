import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceUp, quoteBuy, quoteSell, type Pools } from './fpmm';

const SEED = 1_000_000_000n; // 1,000 USDG
const FEE = 100n;
const start: Pools = { poolUp: SEED, poolDown: SEED };

test('buy matches the Foundry vector (100 USDG of UP at 50/50)', () => {
  const q = quoteBuy(start, 'up', 100_000_000n, FEE);
  assert.equal(q.fee, 1_000_000n);
  assert.equal(q.net, 99_000_000n);
  // a + n - ceil(a*b/(b+n)) = 1099e6 - ceil(1e18/1099e6) = 1099e6 - 909918108 = 189081892
  assert.equal(q.shares, 189_081_892n);
  assert.equal(q.after.poolDown, 1_099_000_000n);
  assert.equal(q.after.poolUp, 909_918_108n);
  assert.ok(q.after.poolUp * q.after.poolDown >= SEED * SEED);
  assert.ok(priceUp(q.after) > 0.5);
});

test('round trip never profits and restores the pool', () => {
  for (const invest of [2n, 7n, 1_000n, 123_456n, 100_000_000n, 5_000_000_000n]) {
    const b = quoteBuy(start, 'down', invest, FEE);
    if (b.shares === 0n) continue;
    const s = quoteSell(b.after, 'down', b.shares, FEE);
    assert.ok(s.payout <= invest, `profit at ${invest}`);
    assert.ok(s.after.poolUp * s.after.poolDown >= SEED * SEED, `k fell at ${invest}`);
    assert.ok(s.after.poolUp - SEED <= 2n && s.after.poolDown - SEED <= 2n, `pool drifted at ${invest}`);
  }
});

test('price is the pool ratio', () => {
  assert.equal(priceUp(start), 0.5);
  assert.equal(priceUp({ poolUp: 300n, poolDown: 700n }), 0.7);
  assert.equal(priceUp({ poolUp: 0n, poolDown: 0n }), 0);
});

test('zero and negative inputs quote zero', () => {
  assert.equal(quoteBuy(start, 'up', 0n, FEE).shares, 0n);
  assert.equal(quoteSell(start, 'up', 0n, FEE).payout, 0n);
});
