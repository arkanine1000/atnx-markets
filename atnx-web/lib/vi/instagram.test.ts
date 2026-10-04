// node --test (through tsx): the pure parts of the Instagram source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { instagramDue, instagramReading, instagramTag, momentumFromSamples, rowTag, rowToReel, INTERVAL_MS, HOT_INTERVAL_MS, type Reel } from './instagram';
import type { Sample } from './samples';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const H = 3600 * 1000;
const D = 24 * H;
const reel = (id: string, agoH: number, plays: number): Reel => ({ id, createdAt: T0 - agoH * H, plays });

test('instagramTag: the TikTok mapping when valid, else the name squashed', () => {
  assert.equal(instagramTag('Grand Theft Auto VI', ['GTA 6'], 'gta6'), 'gta6');
  assert.equal(instagramTag('Grand Theft Auto VI', ['GTA 6'], null), 'grandtheftautovi');
  assert.equal(instagramTag('Grand Theft Auto VI', [], 'not a tag!'), 'grandtheftautovi');
  assert.equal(instagramTag('Ok', []), null);
});

test('rowTag and rowToReel', () => {
  assert.equal(rowTag({ inputUrl: 'https://www.instagram.com/explore/tags/Halloween' }), 'halloween');
  assert.equal(rowTag({ inputUrl: 'https://www.instagram.com/explore/search/keyword/?q=x' }), null);
  assert.deepEqual(rowToReel({ shortCode: 'DeFImSFidtl', timestamp: '2026-10-04T10:00:00.000Z', videoPlayCount: 5658 }), { id: 'DeFImSFidtl', createdAt: Date.parse('2026-10-04T10:00:00.000Z'), plays: 5658 });
  assert.equal(rowToReel({ shortCode: 'x', timestamp: '2026-10-04T10:00:00.000Z' }), null, 'no play count');
  assert.equal(rowToReel({ shortCode: 'x', videoPlayCount: 1 }), null, 'no time');
});

test('instagramReading: the week\'s reels over the week; a page full of this week is read over its span; old reels are out', () => {
  const quiet = instagramReading([reel('a', 2, 7000), reel('b', 50, 14000), reel('old', 30 * 24, 1_000_000)], 12, T0);
  assert.equal(quiet.reelsWeek, 2);
  assert.equal(quiet.reelsDay, 1);
  assert.equal(quiet.capped, false);
  assert.equal(quiet.viewsPerDay, Math.round(21000 / 7));
  const busy = instagramReading(Array.from({ length: 12 }, (_, i) => reel(String(i), i, 1000)), 12, T0);
  assert.equal(busy.capped, true);
  assert.equal(busy.spanH, 11);
  assert.equal(busy.viewsPerDay, Math.round((12000 / 11) * 24));
  assert.equal(instagramReading([], 12, T0).viewsPerDay, null);
  assert.equal(instagramReading([reel('old', 30 * 24, 5)], 12, T0).viewsPerDay, 0, 'reels, none this week: a known 0');
});

test('momentumFromSamples and instagramDue', () => {
  const samples: Sample[] = [
    { sampled_at: new Date(T0 - 2 * D).toISOString(), value: 0, meta: { views_per_day: 500 } },
    { sampled_at: new Date(T0 - 6 * D).toISOString(), value: 0, meta: { views_per_day: 9 } },
  ];
  assert.equal(momentumFromSamples(samples, 1000, T0), 2);
  assert.equal(instagramDue(null, T0), true);
  const at = (ms: number) => new Date(T0 - ms).toISOString();
  assert.equal(instagramDue({ source: 'instagram', level: 100, momentum: null, fetchedAt: at(D) }, T0), false);
  assert.equal(instagramDue({ source: 'instagram', level: 100, momentum: null, fetchedAt: at(INTERVAL_MS - 10 * 60_000) }, T0), true);
  assert.equal(instagramDue({ source: 'instagram', level: 700, momentum: null, fetchedAt: at(HOT_INTERVAL_MS - 10 * 60_000) }, T0), true, 'hot: daily');
});
