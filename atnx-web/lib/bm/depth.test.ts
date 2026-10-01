import { test } from 'node:test';
import assert from 'node:assert/strict';
import { impliedDepth } from './depth';
import { quoteBuy } from './fpmm';

const SEED = 1_000_000_000n;
const pools = { poolUp: SEED, poolDown: SEED };

test('asks climb from the mid and agree with the swap math', () => {
  const d = impliedDepth(pools, 'up', 100n, 0.01, 10);
  assert.equal(d.mid, 0.5);
  assert.ok(d.asks.length === 10);
  assert.ok(d.asks[0].price > 0.5 && d.asks[0].price <= 0.52);
  for (let i = 1; i < d.asks.length; i++) assert.ok(d.asks[i].price > d.asks[i - 1].price);
  // Buying the gross `total` at the fifth level should land the price near that level.
  const l = d.asks[4];
  const q = quoteBuy(pools, 'up', BigInt(Math.round(l.total)), 100n);
  const priceAfter = Number(q.after.poolDown) / Number(q.after.poolUp + q.after.poolDown);
  assert.ok(Math.abs(priceAfter - l.price) < 0.002, `${priceAfter} vs ${l.price}`);
  assert.ok(Math.abs(Number(q.shares) - l.cumShares) / l.cumShares < 0.002);
});

test('bids mirror the other side', () => {
  const d = impliedDepth(pools, 'up', 100n, 0.01, 5);
  const e = impliedDepth(pools, 'down', 100n, 0.01, 5);
  assert.equal(d.bids.length, e.asks.length);
  assert.ok(Math.abs(d.bids[0].price - (1 - e.asks[0].price)) < 1e-9);
  assert.equal(d.bids[0].shares, e.asks[0].shares);
});

test('an empty pool yields no levels', () => {
  const d = impliedDepth({ poolUp: 0n, poolDown: 0n }, 'up', 100n);
  assert.equal(d.asks.length, 0);
  assert.equal(d.bids.length, 0);
});
