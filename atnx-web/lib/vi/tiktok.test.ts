// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { consistentViews, tiktokLevel, tiktokReading, trendFit, tiktokEarlyDue } from './tiktok';
import type { Sample } from './samples';

const T0 = Date.parse('2026-09-25T00:09:00Z');
const H = 3600_000;

// Reads every 3 h of one hashtag, oldest first in `counts`; returned newest
// first, as readSamples gives them.
function series(counts: number[], tag = 'tag', stepH = 3): { samples: Sample[]; now: number } {
  const samples = counts.map((value, i) => ({
    sampled_at: new Date(T0 + i * stepH * H).toISOString(),
    value,
    meta: { hashtag: tag },
  }));
  return { samples: samples.reverse(), now: T0 + (counts.length - 1) * stepH * H + 60_000 };
}

// Steady growth of `perH` a read, with the jitter seen from the vendor.
function jittered(start: number, perH: number, jitter: number[]): number[] {
  return jitter.map((j, i) => start + perH * 3 * i + j);
}

test('trendFit ignores a stale total', () => {
  const pts = [0, 3, 6, 9, 12].map((h) => ({ h, v: 1000 + 10 * h }));
  pts[3].v = pts[1].v; // one read repeats an older total
  assert.equal(trendFit(pts).slope, 10);
});

test('slow tag: jitter no longer reads as zero growth', () => {
  // ~15 videos/h with +-20 video jitter; the newest pair happens to be 0.
  const counts = jittered(234_600, 15, [0, 20, -15, 10, -20, 15, 0]);
  counts[6] = counts[5];
  const { samples, now } = series(counts);
  const r = tiktokReading(samples, now);
  assert.ok(r.videosPerHour! > 8 && r.videosPerHour! < 22, `rate ${r.videosPerHour}`);
  assert.ok(r.level! > 350, `level ${r.level}`);
});

test('drops come through the trend, not the newest pair', () => {
  const counts = jittered(3_055_000, 150, [0, 100, -80, 60, -40, 90]);
  counts.push(counts[5] - 450); // the vendor steps back 450 videos
  const { samples, now } = series(counts);
  const r = tiktokReading(samples, now);
  assert.ok(r.videosPerHour! > 100, `rate ${r.videosPerHour}`);
});

test('a real spike shows on its first read', () => {
  const counts = jittered(1_765_000, 30, [0, 15, -10, 5, -15, 10]);
  counts.push(counts[5] + 3 * 150); // 150/h, 5x the recent rate
  const { samples, now } = series(counts);
  const r = tiktokReading(samples, now);
  assert.equal(r.videosPerHour, 150);
  assert.equal(r.level, tiktokLevel(150 * 24));
});

// Cumulative counts every 3 h for `hours`, growing at rateAt(hour of day).
function daily(hours: number, rateAt: (hourOfDay: number) => number, start = 1_000_000): number[] {
  const out = [start];
  for (let h = 3; h <= hours; h += 3) out.push(out[out.length - 1] + 3 * rateAt(h % 24));
  return out;
}

test('a daily posting rhythm is not momentum: same hours yesterday', () => {
  // 40/h by day, 10/h by night, every day alike.
  const counts = daily(39, (hod) => (hod >= 8 && hod < 20 ? 40 : 10));
  const { samples, now } = series(counts);
  assert.equal(tiktokReading(samples, now).momentum, null);
});

test('a rise against the same hours yesterday is momentum', () => {
  // Steady 30/h, then the last 12 h at 90/h.
  const counts = daily(39, () => 30);
  for (let i = counts.length - 4; i < counts.length; i++) counts[i] = counts[i - 1] + 3 * 90;
  const { samples, now } = series(counts);
  const r = tiktokReading(samples, now);
  assert.ok(r.momentum !== null && r.momentum > 2, `momentum ${r.momentum}`);
});

test('no momentum on a tiny baseline', () => {
  // Yesterday under 2 videos an hour: 0.5/h, now 3/h.
  const counts = daily(39, () => 0.5);
  for (let i = counts.length - 4; i < counts.length; i++) counts[i] = counts[i - 1] + 3 * 3;
  const { samples, now } = series(counts);
  assert.equal(tiktokReading(samples, now).momentum, null);
});

test('steady growth within the noise has no momentum', () => {
  const counts = jittered(500_000, 40, [0, 12, -9, 6, -12, 9, -6]);
  const { samples, now } = series(counts);
  assert.equal(tiktokReading(samples, now).momentum, null);
});

test('warm-up: the newest pair until the trend has enough reads', () => {
  const { samples, now } = series([1000, 1030, 1090]);
  const r = tiktokReading(samples, now);
  assert.equal(r.videosPerHour, 20);
  assert.equal(r.momentum, null);
});

test('reads of a previous hashtag are not mixed in', () => {
  const old = series([17_000, 17_100, 17_200]).samples.map((s) => ({ ...s, meta: { hashtag: 'grandtheftautovi' } }));
  const cur = series([2_190_000, 2_190_500], 'gta6');
  const shifted = cur.samples.map((s) => ({ ...s, sampled_at: new Date(Date.parse(s.sampled_at) + 9 * H).toISOString() }));
  const r = tiktokReading([...shifted, ...old], cur.now + 9 * H);
  assert.equal(r.videosPerHour, Number((500 / 3).toFixed(2)));
});

test('a stale series has no reading', () => {
  const { samples, now } = series([1000, 1030, 1060]);
  assert.equal(tiktokReading(samples, now + 10 * H).level, null);
});

test('an off-cycle read next to a scheduled one is dropped', () => {
  const { samples, now } = series([1000, 1030, 1060, 1090]);
  const extra = { sampled_at: new Date(Date.parse(samples[0].sampled_at) - 20 * 60_000).toISOString(), value: 1500, meta: { hashtag: 'tag' } };
  const r = tiktokReading([samples[0], extra, ...samples.slice(1)], now);
  assert.equal(r.videosPerHour, 10);
});

import { hashtagsWanted } from './tiktok';

test('a market with no hashtag asks again after a day, not every read', () => {
  const t0 = Date.parse('2026-09-25T15:07:00Z');
  const none = {
    term: 'Lego Tuxedo Cat Alt Builds',
    aliases: ['Lego Cat Alt Builds'],
    stored: { source: 'tiktok' as const, level: null, momentum: null, fetchedAt: new Date(t0).toISOString(), meta: { hashtag: null, discovered_at: new Date(t0).toISOString(), queried: 0 } },
  };
  assert.deepEqual(hashtagsWanted(none, t0 + 3 * H), [], 'three hours later: still nothing to ask');
  assert.deepEqual(hashtagsWanted(none, t0 + 23 * H), []);
  assert.ok(hashtagsWanted(none, t0 + 25 * H).length > 0, 'a day later: the guesses again');
});

test('a mapped market asks for its hashtag every three hours', () => {
  const t0 = Date.parse('2026-09-25T15:07:00Z');
  const mapped = {
    term: 'Skibidi Toilet',
    stored: { source: 'tiktok' as const, level: 500, momentum: null, fetchedAt: new Date(t0).toISOString(), meta: { hashtag: 'skibiditoilet', discovered_at: new Date(t0 - 2 * 24 * H).toISOString() } },
  };
  assert.deepEqual(hashtagsWanted(mapped, t0 + 1 * H), []);
  assert.deepEqual(hashtagsWanted(mapped, t0 + 3 * H), ['skibiditoilet']);
});

test('the view totals give a views-per-hour trend beside the video counts', () => {
  // 15 videos/h and 400k views/h, both jittered, over 7 reads.
  const counts = jittered(234_600, 15, [0, 20, -15, 10, -20, 15, 0]);
  const views = jittered(9_000_000_000, 400_000, [0, 50_000, -30_000, 20_000, -40_000, 30_000, 0]);
  const { samples, now } = series(counts);
  const withViews = samples.map((smp, i) => ({ ...smp, meta: { ...smp.meta, view_count: views[views.length - 1 - i] } }));
  const r = tiktokReading(withViews, now);
  assert.ok(r.videosPerHour! > 8 && r.videosPerHour! < 22, `videos ${r.videosPerHour}`);
  assert.ok(r.viewsPerHour! > 350_000 && r.viewsPerHour! < 450_000, `views ${r.viewsPerHour}`);
  assert.equal(tiktokReading(samples, now).viewsPerHour, null, 'no view totals: no views trend');
  // A view total missing on the newest read leaves the views trend stale: null.
  const staleNewest = withViews.map((smp, i) => (i === 0 ? { ...smp, meta: { ...smp.meta, view_count: null } } : smp));
  assert.equal(tiktokReading(staleNewest, now).viewsPerHour, null);
});

test('view totals that flip to an unrelated value are dropped before the views trend', () => {
  // #captainsparklez: video count flat at 10,070; views alternate 201M / 92.7M.
  const videos = [10069, 10069, 10069, 10070, 10070, 10070, 10070, 10070];
  const views = [201_157_148, 201_162_230, 201_168_849, 201_176_789, 92_662_276, 201_191_938, 92_673_639, 201_206_447];
  const { samples, now } = series(videos);
  const withViews = samples.map((smp, i) => ({ ...smp, meta: { ...smp.meta, view_count: views[views.length - 1 - i] } }));
  const r = tiktokReading(withViews, now);
  assert.ok(r.viewsPerHour !== null && r.viewsPerHour < 5_000, `views/h ${r.viewsPerHour} should be the few thousand real ones, not 36M`);
  // With the newest read itself an outlier there is no views trend at all.
  const flipped = [...views.slice(0, 7), 92_680_000];
  const bad = samples.map((smp, i) => ({ ...smp, meta: { ...smp.meta, view_count: flipped[flipped.length - 1 - i] } }));
  assert.equal(tiktokReading(bad, now).viewsPerHour, null);
  const run = videos.map((v, i) => ({ h: i * 3, v, w: views[i] }));
  assert.equal(consistentViews(run).length, 6, 'two flipped reads dropped');
});

test('tiktokEarlyDue: a young mapped tag with no level is read again an hour after its first read, by any pass', () => {
  const t0 = Date.parse('2026-09-30T12:00:00Z');
  const mapped = { source: 'tiktok' as const, level: null, momentum: null, fetchedAt: new Date(t0).toISOString(), meta: { hashtag: 'capybara', discovered_at: new Date(t0).toISOString() } };
  assert.equal(tiktokEarlyDue(mapped, t0 + 30 * 60_000), false, 'too soon');
  assert.equal(tiktokEarlyDue(mapped, t0 + 66 * 60_000), true, 'an hour and the slack');
  assert.deepEqual(hashtagsWanted({ term: 'Capybara Memes', stored: mapped }, t0 + 66 * 60_000), ['capybara'], 'wanted despite the three-hour interval');
  assert.equal(tiktokEarlyDue({ ...mapped, level: 420 }, t0 + 66 * 60_000), false, 'has a level');
  assert.equal(tiktokEarlyDue({ ...mapped, meta: { ...mapped.meta, discovered_at: new Date(t0 - 4 * 3600_000).toISOString() } }, t0 + 66 * 60_000), false, 'not young');
  assert.equal(tiktokEarlyDue({ ...mapped, meta: { hashtag: null, discovered_at: mapped.meta.discovered_at } }, t0 + 66 * 60_000), false, 'no tag');
  assert.equal(tiktokEarlyDue(null), false);
});
