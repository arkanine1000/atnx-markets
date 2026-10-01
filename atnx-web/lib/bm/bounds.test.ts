import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bounds, fromE2, multiplier, toE2 } from './bounds';

// The eight rows of the design doc's table.
const TABLE: Array<[number, number, number, number]> = [
  // start VI, multiplier (2 dp), lower, upper
  [10, 5, 0, 50],
  [50, 5, 10, 250],
  [100, 5, 20, 500],
  [200, 2.68, 75, 540],
  [300, 2.01, 150, 600],
  [500, 1.54, 330, 770],
  [1000, 1.22, 820, 1200],
  [5000, 1.2, 4200, 6000],
];

test('bounds reproduce the design doc table', () => {
  for (const [vi, m, lower, upper] of TABLE) {
    const b = bounds(vi);
    // The doc rounds 1.5338 up to 1.54; a hundredth of tolerance covers it.
    assert.ok(Math.abs(b.multiplier - m) < 0.011, `multiplier at ${vi}: ${b.multiplier}`);
    assert.equal(b.lower, lower, `lower at ${vi}`);
    assert.equal(b.upper, upper, `upper at ${vi}`);
  }
});

test('multiplier is clamped to [1.2, 5]', () => {
  assert.equal(multiplier(1), 5);
  assert.equal(multiplier(1e9), 1.2);
});

test('lower bound under 5 becomes 0; the start always sits strictly inside', () => {
  for (const vi of [1, 5, 10, 24, 25, 26, 99, 101, 999, 1001, 12345]) {
    const b = bounds(vi);
    assert.ok(b.lower < vi && vi < b.upper, `start ${vi} inside ${b.lower}-${b.upper}`);
    if (vi / b.multiplier < 5) assert.equal(b.lower, 0);
  }
});

test('rejects a non-positive start', () => {
  assert.throws(() => bounds(0));
  assert.throws(() => bounds(-3));
  assert.throws(() => bounds(Number.NaN));
});

test('E2 round trip', () => {
  assert.equal(toE2(123.456), 12346n);
  assert.equal(fromE2(12346n), 123.46);
  assert.equal(toE2(0), 0n);
});
