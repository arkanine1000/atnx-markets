// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { medianImpressionsPerHour, xImpressionsPerHour, xQuery, xRate, X_SHIFT_S } from './x';

const NOW = Date.parse('2026-09-26T18:00:00Z');
const at = (secondsBeforeUntil: number) => new Date(NOW - X_SHIFT_S * 1000 - secondsBeforeUntil * 1000).toISOString();

test('the query window ends two hours ago so impressions have matured', () => {
  const q = xQuery('Donald Trump', ['Trump'], NOW);
  const until = Math.floor(NOW / 1000) - X_SHIFT_S;
  assert.match(q, new RegExp(`since_time:${until - 3600} until_time:${until} `));
  assert.match(q, /^\("Donald Trump" OR "Trump"\)/);
  assert.match(q, /-filter:retweets$/);
});

test('xRate under the cap is the count in the window; at the cap it is read off the span from the window end', () => {
  const until = NOW - X_SHIFT_S * 1000;
  const few = [{ createdAt: at(100) }, { createdAt: at(2000) }];
  assert.equal(xRate(few, false, until), 2);
  // 60 tweets spanning 5 minutes back from the window's end: 720 an hour.
  const capped = Array.from({ length: 60 }, (_, i) => ({ createdAt: at(5 * (i + 1)) }));
  assert.equal(Math.round(xRate(capped, true, until)), 720);
});

test('impressions per hour scale the fetched views to the hour the rate describes', () => {
  // Uncapped: the fetched tweets are the whole hour.
  assert.equal(xImpressionsPerHour(5000, 25, 25), 5000);
  // Capped: 60 tweets in 5 minutes at 720/h drew 3,000 views -> 36,000 an hour.
  assert.equal(xImpressionsPerHour(3000, 60, 720), 36_000);
  assert.equal(xImpressionsPerHour(0, 0, 0), 0);
});

test('the level takes the median of the last day of impression reads, the newest included', () => {
  const s = (hoursAgo: number, rate: number, views: number, tweets: number) => ({ sampled_at: new Date(NOW - hoursAgo * 3600_000).toISOString(), value: rate, meta: { views, tweets } });
  const samples = [s(3, 45, 4_500, 45), s(6, 160, 32_000, 60), s(9, 150, 30_000, 60), s(12, 140, 28_000, 60), s(30, 900, 900_000, 60)];
  // reads: 6h 85,333/h; 9h 75,000; 12h 65,333; 3h 4,500; current 10,000 -> median 65,333. The 30 h read is out.
  assert.equal(medianImpressionsPerHour(samples, 10_000, NOW), 65_333);
  assert.equal(medianImpressionsPerHour([], 10_000, NOW), 10_000, 'no history: the read');
  assert.equal(medianImpressionsPerHour([s(0.2, 1, 1, 1)], 10_000, NOW), 10_000, 'the just-written sample is not counted twice');
});
