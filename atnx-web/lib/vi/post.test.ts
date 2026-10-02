// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parsePostUrl, postKey, postLevel, postReadDue, postReading, MIN_GAP_H } from './post';
import type { Sample } from './samples';

const H = 3600_000;
const T0 = Date.parse('2026-10-02T17:00:00Z');

test('parsePostUrl: the post behind a TikTok, Instagram or X link, canonical; nothing else', () => {
  assert.deepEqual(parsePostUrl('https://www.tiktok.com/@konstantin2man/video/7686920253829287189?lang=en'), { platform: 'tiktok', id: '7686920253829287189', url: 'https://www.tiktok.com/@konstantin2man/video/7686920253829287189' });
  assert.equal(parsePostUrl('https://www.tiktok.com/@konstantin2man'), null, 'a profile');
  assert.equal(parsePostUrl('https://www.tiktok.com/tag/nosfercatu'), null, 'a hashtag page');
  assert.equal(parsePostUrl('https://vm.tiktok.com/ZMabc123/'), null, 'a short link needs a redirect');
  assert.deepEqual(parsePostUrl('https://www.instagram.com/reel/Dc6LO2kiHUm/?stkn=MWVw'), { platform: 'instagram', id: 'Dc6LO2kiHUm', url: 'https://www.instagram.com/p/Dc6LO2kiHUm/' });
  assert.deepEqual(parsePostUrl('https://instagram.com/capyandduck/p/Dc6LO2kiHUm/')?.id, 'Dc6LO2kiHUm');
  assert.equal(parsePostUrl('https://www.instagram.com/capyandduck/'), null);
  assert.deepEqual(parsePostUrl('https://x.com/tech/status/2'), { platform: 'x', id: '2', url: 'https://x.com/i/status/2' });
  assert.deepEqual(parsePostUrl('https://twitter.com/jack/status/20?s=20')?.id, '20');
  assert.equal(parsePostUrl('https://x.com/jack'), null);
  assert.equal(parsePostUrl('https://www.youtube.com/watch?v=abc'), null);
  assert.equal(parsePostUrl('not a url'), null);
  assert.equal(parsePostUrl(null), null);
  assert.equal(postKey({ platform: 'x', id: '20' }), 'x:20');
});

test('postLevel: 1k a day is 100, tenfold per 200', () => {
  assert.equal(postLevel(0), 0);
  assert.equal(postLevel(1_000), 100);
  assert.equal(postLevel(100_000), 500);
  assert.equal(postLevel(10_000_000), 900);
});

test('postReadDue: hourly through the first day, every three hours after', () => {
  const stored = (fetchedAgoMs: number, firstAgoMs: number) => ({
    source: 'post' as const,
    level: 300,
    momentum: null,
    fetchedAt: new Date(T0 - fetchedAgoMs).toISOString(),
    meta: { first_read_at: new Date(T0 - firstAgoMs).toISOString() },
  });
  assert.equal(postReadDue(null, T0), true, 'never read');
  assert.equal(postReadDue(stored(30 * 60_000, 30 * 60_000), T0), false, 'half an hour into a young market');
  assert.equal(postReadDue(stored(50 * 60_000, 50 * 60_000), T0), true, 'an hour, less the slack, into a young market');
  assert.equal(postReadDue(stored(50 * 60_000, 30 * H), T0), false, 'an hour into an old market');
  assert.equal(postReadDue(stored(170 * 60_000, 30 * H), T0), true, 'three hours, less the slack, into an old market');
});

// Reads of one or more posts, newest first, as readSamples gives them.
function reads(rows: { post: string; agoH: number; views: number | null; createdAgoH?: number }[]): Sample[] {
  return rows
    .map((r) => ({
      sampled_at: new Date(T0 - r.agoH * H).toISOString(),
      value: r.views ?? 0,
      meta: { post: r.post, platform: r.post.split(':')[0], views: r.views, created_at: r.createdAgoH === undefined ? null : new Date(T0 - r.createdAgoH * H).toISOString() },
    }))
    .sort((a, b) => Date.parse(b.sampled_at) - Date.parse(a.sampled_at));
}

test('postReading: one read gives the lifetime average over the post age', () => {
  // Nosfercatu's post: 9.7M plays, 14 days old.
  const r = postReading(reads([{ post: 'tiktok:1', agoH: 0, views: 9_700_000, createdAgoH: 14 * 24 }]), T0);
  assert.equal(r.posts, 1);
  assert.equal(r.onAverage, 1);
  assert.equal(r.viewsPerDay, Math.round((9_700_000 / (14 * 24)) * 24));
  assert.equal(r.momentum, null);
  // A minutes-old post is read over at least an hour.
  const fresh = postReading(reads([{ post: 'tiktok:2', agoH: 0, views: 5_000, createdAgoH: 0.1 }]), T0);
  assert.equal(fresh.viewsPerDay, 5_000 * 24);
  // No creation time and one read: nothing to read.
  assert.equal(postReading(reads([{ post: 'x:3', agoH: 0, views: 100 }]), T0).viewsPerDay, null);
});

test('postReading: two reads give the growth between them, and the sum is over posts', () => {
  const s = reads([
    { post: 'tiktok:1', agoH: 0, views: 9_712_000, createdAgoH: 14 * 24 },
    { post: 'tiktok:1', agoH: 1, views: 9_700_000, createdAgoH: 14 * 24 },
    { post: 'instagram:a', agoH: 0, views: 160_000, createdAgoH: 27 * 24 },
    { post: 'instagram:a', agoH: 3, views: 157_000, createdAgoH: 27 * 24 },
  ]);
  const r = postReading(s, T0);
  assert.equal(r.posts, 2);
  assert.equal(r.onAverage, 0);
  assert.equal(r.viewsPerDay, Math.round((12_000 + 1_000) * 24));
  assert.equal(r.momentum, null, 'nothing a day back yet');
});

test('postReading: reads too close together are one read; a drop reads as zero growth; a stale post has no rate', () => {
  const close = reads([
    { post: 'tiktok:1', agoH: 0, views: 1_000_000, createdAgoH: 48 },
    { post: 'tiktok:1', agoH: MIN_GAP_H / 2, views: 999_000, createdAgoH: 48 },
  ]);
  assert.equal(postReading(close, T0).onAverage, 1, 'the pair is too close, so the lifetime average stands');
  const drop = reads([
    { post: 'tiktok:1', agoH: 0, views: 990_000, createdAgoH: 48 },
    { post: 'tiktok:1', agoH: 2, views: 1_000_000, createdAgoH: 48 },
  ]);
  assert.equal(postReading(drop, T0).viewsPerDay, 0);
  const stale = reads([{ post: 'tiktok:1', agoH: 12, views: 1_000_000, createdAgoH: 48 }]);
  assert.equal(postReading(stale, T0).viewsPerDay, null);
  // A photo post with no view count is not a reading; a sibling video is.
  const mixed = reads([
    { post: 'instagram:photo', agoH: 0, views: null, createdAgoH: 10 },
    { post: 'instagram:video', agoH: 0, views: 24_000, createdAgoH: 24 },
  ]);
  const m = postReading(mixed, T0);
  assert.equal(m.posts, 1);
  assert.equal(m.viewsPerDay, 24_000);
});

test('postReading: momentum against the rate a day earlier, once every post has one', () => {
  // 10k/h today, 5k/h yesterday.
  const s = reads([
    { post: 'tiktok:1', agoH: 0, views: 500_000, createdAgoH: 72 },
    { post: 'tiktok:1', agoH: 1, views: 490_000, createdAgoH: 72 },
    { post: 'tiktok:1', agoH: 24, views: 300_000, createdAgoH: 72 },
    { post: 'tiktok:1', agoH: 27, views: 285_000, createdAgoH: 72 },
  ]);
  const r = postReading(s, T0);
  assert.equal(r.viewsPerDay, 10_000 * 24);
  assert.ok(r.momentum !== null && Math.abs(r.momentum - 2) < 1e-9, `momentum ${r.momentum}`);
});
