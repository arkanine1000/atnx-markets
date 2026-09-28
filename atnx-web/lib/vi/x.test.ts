// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyTweetVerdicts, comparableSamples, medianImpressionsPerHour, xImpressionsPerHour, xQuery, xRate, X_SHIFT_S, type Tweet } from './x';

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

test('applyTweetVerdicts: kept posts set the rate under the cap and scale it at the cap', () => {
  const tweets: Tweet[] = [
    { id: 'a', createdAt: at(10), viewCount: 100, likeCount: 1 },
    { id: 'b', createdAt: at(20), viewCount: 900, likeCount: 9 },
    { id: 'c', createdAt: at(30), viewCount: 50, likeCount: 0 },
    { id: 'd', createdAt: at(40), viewCount: 50, likeCount: 0 },
  ];
  const keep = new Set(['a', 'b']);
  const under = applyTweetVerdicts(tweets, keep, 4, false);
  assert.deepEqual(under.kept.map((t) => t.id), ['a', 'b']);
  assert.equal(under.share, 0.5);
  assert.equal(under.rate, 2, 'under the cap the kept count is the rate');
  assert.equal(under.views, 1000);
  assert.equal(under.likes, 10);
  const capped = applyTweetVerdicts(tweets, keep, 720, true);
  assert.equal(capped.rate, 360, 'at the cap the read rate scales by the kept share');
  assert.equal(applyTweetVerdicts([], keep, 0, false).share, 0);
});

test('comparableSamples: a filtered read compares only with filtered samples', () => {
  const samples = [
    { sampled_at: at(3600), value: 10, meta: { filtered: 1 } },
    { sampled_at: at(7200), value: 30, meta: { filtered: 0 } },
    { sampled_at: at(10800), value: 40, meta: null },
  ];
  assert.deepEqual(comparableSamples(samples, true).map((s) => s.value), [10]);
  assert.deepEqual(comparableSamples(samples, false).map((s) => s.value), [10, 30, 40]);
});
