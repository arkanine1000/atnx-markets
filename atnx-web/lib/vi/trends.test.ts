// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { termSignal, trendsLevel, trendsKeyword, normalizeSearchTerm } from './trends';

const times = Array.from({ length: 8 }, (_, i) => new Date(Date.parse('2026-09-19T00:00:00Z') + i * 864e5).toISOString());

test('a term that rounds to 0 against the benchmark is below resolution, not zero', () => {
  const r = termSignal('Big Chungus', [0, 0, 1, 0, 0, 0, 0, 0], 40, times);
  assert.equal(r.level, null);
  assert.equal(r.momentum, null);
  assert.equal(r.meta?.below_resolution, 1);
});

test('a small but measurable term keeps its level', () => {
  const r = termSignal('Toyota AE86', [2, 2, 3, 2, 2, 3, 2, 2], 40, times);
  assert.equal(r.level, trendsLevel(2 / 40));
  assert.equal(r.meta?.below_resolution, undefined);
  assert.equal(r.momentum, null, 'quantised: too few search units for momentum');
});

test('a well-measured term keeps level and momentum as before', () => {
  const r = termSignal('Halloween', [30, 32, 35, 40, 44, 50, 60, 62], 40, times);
  assert.equal(r.level, trendsLevel((60 / 40 + 62 / 40) / 2));
  assert.ok(r.momentum !== null && r.momentum > 1);
});

test('trendsKeyword: a topic id takes the slot alone; normalizeSearchTerm drops a trailing qualifier', () => {
  assert.equal(trendsKeyword({ term: 'Cars', aliases: ['Pixar Cars'], topic: '/m/03q0r1' }), '/m/03q0r1');
  assert.equal(trendsKeyword({ term: 'Cars', aliases: ['Pixar Cars'], topic: null }), 'Cars + Pixar Cars');
  assert.equal(normalizeSearchTerm({ name: 'Cars (2006 film)' }), 'Cars');
  assert.equal(normalizeSearchTerm({ name: 'Verity (Minecraft ARG)' }), 'Verity');
  assert.equal(normalizeSearchTerm({ name: '(500) Days of Summer' }), '500 Days of Summer');
});
