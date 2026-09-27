// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { latestOwnReach, ownImpressionsPerDay, type OwnPost } from './x-account';
import type { Sample } from '../vi/samples';

const NOW = Date.parse('2026-09-27T16:00:00Z');
const H = 3600_000;
const post = (hoursAgo: number, views: number, rt = false): OwnPost => ({ createdAt: new Date(NOW - hoursAgo * H).toISOString(), viewCount: views, ...(rt ? { retweeted_tweet: {} } : {}) });

test('retweets are dropped; a partial page spreads over a week', () => {
  const r = ownImpressionsPerDay([post(2, 5_000_000), post(10, 4_000_000, true), post(30, 3_000_000)], NOW);
  assert.equal(r.posts, 2);
  assert.equal(r.windowDays, 7);
  assert.equal(r.perDay, Math.round(8_000_000 / 7));
});

test('a full page inside the week spreads over the span it covers, at least a day', () => {
  const posts = Array.from({ length: 20 }, (_, i) => post(i * 1.2, 1_000_000)); // 20 posts over ~23 h
  const r = ownImpressionsPerDay(posts, NOW);
  assert.equal(r.windowDays, 1);
  assert.equal(r.perDay, 20_000_000);
  const spread = Array.from({ length: 20 }, (_, i) => post(i * 6, 1_000_000)); // over 4.75 days
  const r2 = ownImpressionsPerDay(spread, NOW);
  assert.ok(r2.windowDays > 4.7 && r2.windowDays < 4.8, `window ${r2.windowDays}`);
  assert.equal(r2.perDay, Math.round(20_000_000 / r2.windowDays));
});

test('posts older than a week do not count; an all-retweet page is zero own reach; no posts is unknown', () => {
  assert.equal(ownImpressionsPerDay([post(24 * 8, 9_000_000), post(1, 100)], NOW).perDay, Math.round(100 / 7));
  const rts = ownImpressionsPerDay([post(1, 1e6, true), post(2, 1e6, true)], NOW);
  assert.equal(rts.perDay, 0);
  assert.equal(rts.posts, 0);
  assert.equal(ownImpressionsPerDay([], NOW).perDay, null);
});

test('latestOwnReach takes the newest fresh sample of the handle', () => {
  const s = (hoursAgo: number, handle: string, v: number): Sample => ({ sampled_at: new Date(NOW - hoursAgo * H).toISOString(), value: v, meta: { handle, posts: 3 } });
  const samples = [s(2, 'elonmusk', 20_000_000), s(8, 'elonmusk', 18_000_000), s(1, 'other', 5)];
  assert.deepEqual(latestOwnReach(samples, 'elonmusk', NOW), { perDay: 20_000_000, posts: 3, readAt: samples[0].sampled_at });
  assert.equal(latestOwnReach([s(60, 'elonmusk', 1)], 'elonmusk', NOW), null, 'older than two days');
  assert.equal(latestOwnReach(samples, 'nobody', NOW), null);
});
