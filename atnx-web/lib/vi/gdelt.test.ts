// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gdeltApplies, gdeltFromDays, gdeltLevel, gdeltPatterns, gdeltPhrases, samplesToDays } from './gdelt';
import type { Sample } from './samples';

const NOW = Date.parse('2026-09-25T15:07:00Z');

test('phrases: the name and searchable aliases, distinct, at most four', () => {
  assert.deepEqual(gdeltPhrases('Grand Theft Auto VI', ['GTA 6', 'GTA VI', 'gta 6', 'Grand Theft Auto 6', 'Vice City']), ['Grand Theft Auto VI', 'GTA 6', 'GTA VI', 'Grand Theft Auto 6']);
});

test('name patterns match whole AllNames entries only', () => {
  const re = new RegExp(gdeltPatterns(['Meta']).names);
  assert.ok(re.test('mark zuckerberg,12;meta,40;instagram,88'));
  assert.ok(re.test('meta,3'));
  assert.ok(!re.test('metallica,12;metamask,40'), 'Metallica is not Meta');
  const trump = new RegExp(gdeltPatterns(['Donald Trump', 'Trump']).names);
  assert.ok(trump.test('joe biden,1;donald trump,55'));
});

test('title patterns match whole words, and escape regex characters', () => {
  const t = new RegExp(gdeltPatterns(['GTA 6', 'Grand Theft Auto VI']).title);
  assert.ok(t.test("'gta 6' marketing campaign takes over miami"));
  assert.ok(!t.test('gta 60 fps mod'));
  const dots = new RegExp(gdeltPatterns(['Avengers: Doomsday', 'A.I. (film)']).title);
  assert.ok(dots.test('avengers: doomsday trailer breaks records'));
  assert.ok(!dots.test('aXi. film'), 'the dot is literal');
});

test('memes are out of scope; everything else is in', () => {
  assert.equal(gdeltApplies('memes'), false);
  for (const c of ['people', 'tech', 'crypto', 'film_tv', 'gaming', 'politics', null]) assert.equal(gdeltApplies(c), true);
});

const s = (day: string, value: number, total = 310_000, at = `${day}T23:59:00Z`): Sample => ({ sampled_at: at, value, meta: { day, total, count: Math.round((value * total) / 100), resolution: '1d-gkg' } });

test('samplesToDays keeps the newest row per day and a partial today only once it is big enough', () => {
  const days = samplesToDays(
    [
      s('2026-09-23', 0.01, 310_000, '2026-09-24T02:07:00Z'),
      s('2026-09-23', 0.02, 316_000, '2026-09-24T03:07:00Z'), // re-counted: this one wins
      s('2026-09-24', 0.03),
      s('2026-09-25', 0.5, 12_000, '2026-09-25T02:07:00Z'), // too little of today yet
    ],
    Date.parse('2026-09-25T02:30:00Z')
  );
  assert.deepEqual(days.map(({ day, value }) => ({ day, value })), [
    { day: '2026-09-23', value: 0.02 },
    { day: '2026-09-24', value: 0.03 },
  ]);
  const later = samplesToDays([s('2026-09-24', 0.03), s('2026-09-25', 0.04, 160_000, '2026-09-25T15:07:00Z')], NOW);
  assert.equal(later.at(-1)?.day, '2026-09-25');
});

test('a steady week reads its level on the carried-over scale, with momentum near 1', () => {
  const days = ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'].map((day) => ({ day, value: 0.01, count: 31 }));
  const r = gdeltFromDays(days, NOW);
  assert.equal(r.level, gdeltLevel(0.01));
  assert.equal(r.level, 500);
  assert.equal(r.momentum, 1);
  assert.equal(r.meta?.resolution, '1d-gkg');
});

test('no articles all week is a real zero', () => {
  const days = ['2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'].map((day) => ({ day, value: 0 }));
  assert.equal(gdeltFromDays(days, NOW).level, 0);
});

test('no samples, or a job that stopped two days ago, is unknown, never zero', () => {
  assert.equal(gdeltFromDays([], NOW).level, null);
  const stale = ['2026-09-18', '2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22'].map((day) => ({ day, value: 0.02 }));
  assert.equal(gdeltFromDays(stale, NOW).level, null);
});

test('momentum ignores a half-counted today', () => {
  const week = ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23', '2026-09-24'].map((day) => ({ day, value: 0.01, count: 31 }));
  const r = gdeltFromDays([...week, { day: '2026-09-25', value: 0, count: 0 }], NOW);
  assert.equal(r.momentum, 1, 'no articles yet today is not a collapse');
  assert.ok(r.level! < 500, 'but today still counts toward the level');
});

test('a rarely mentioned name gets no momentum', () => {
  const rare = ['2026-09-19', '2026-09-20', '2026-09-21', '2026-09-22', '2026-09-23'].map((day) => ({ day, value: 0.0006, count: 2 }));
  const r = gdeltFromDays([...rare, { day: '2026-09-24', value: 0, count: 0 }], NOW);
  assert.equal(r.momentum, null);
  assert.ok(r.level! > 0);
});
