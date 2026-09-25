// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blendScores, combine, RAMP_MS, type Components } from './score';

// The ramp maths, over the 48 h span it had (RAMP_MS is 0 pre-launch).
const SPAN = 48 * 3600 * 1000;
const blend = (a: number, b: number, since: number, now: number) => blendScores(a, b, since, now, SPAN);

const T0 = Date.parse('2026-09-25T14:00:00Z');

test('blendScores ramps linearly over the span', () => {
  assert.equal(blend(150, 530, T0, T0 - 1), 150, 'before the start');
  assert.equal(blend(150, 530, T0, T0), 150, 'at the start');
  assert.equal(blend(150, 530, T0, T0 + SPAN / 2), 340, 'halfway');
  assert.equal(blend(150, 530, T0, T0 + SPAN), 530, 'at the end');
  assert.equal(blend(530, 150, T0, T0 + SPAN / 4), 435, 'works downward too');
  assert.equal(blend(150, 530, NaN, T0), 530, 'no start means no ramp');
});

test('blendScores moves slowly enough per 5-minute write', () => {
  const step = blend(150, 530, T0, T0 + 5 * 60_000) - blend(150, 530, T0, T0);
  assert.ok(step <= 1, `step ${step}`);
});

test('ramps are off pre-launch: a change lands at once', () => {
  assert.equal(RAMP_MS, 0);
  assert.equal(blendScores(150, 530, T0, T0), 530);
});

const at = new Date(T0).toISOString();
const creator: Components = {
  youtube: { source: 'youtube', level: 560, momentum: null, fetchedAt: at },
  x: { source: 'x', level: 0, momentum: null, fetchedAt: at },
  bluesky: { source: 'bluesky', level: 0, momentum: null, fetchedAt: at },
  trends: { source: 'trends', level: 0, momentum: null, fetchedAt: at },
  wikipedia: { source: 'wikipedia', level: 0, momentum: null, fetchedAt: at },
};

test('known zeros pull the level down by default', () => {
  const c = combine(creator)!;
  assert.equal(c.level, Math.round((0.2 * 560) / (0.2 + 0.25 + 0.2 + 0.3 + 0.15)));
});

test('ignoreZeros drops the listed zeros only', () => {
  const all = combine(creator, { ignoreZeros: ['x', 'bluesky', 'trends', 'wikipedia'] })!;
  assert.equal(all.level, 560);
  assert.deepEqual(all.sourcesPresent, ['youtube']);
  const some = combine(creator, { ignoreZeros: ['x'] })!;
  assert.equal(some.level, Math.round((0.2 * 560) / (0.2 + 0.2 + 0.3 + 0.15)));
});

test('ignoreZeros never hides a non-zero reading', () => {
  const c = combine({ ...creator, x: { source: 'x', level: 300, momentum: null, fetchedAt: at } }, { ignoreZeros: ['x', 'bluesky', 'trends', 'wikipedia'] })!;
  assert.equal(c.level, Math.round((0.2 * 560 + 0.25 * 300) / 0.45));
});

test('all ignored zeros and nothing else is still no data', () => {
  const only = { x: creator.x, trends: creator.trends } as Components;
  assert.equal(combine(only, { ignoreZeros: ['x', 'trends'] }), null);
});
