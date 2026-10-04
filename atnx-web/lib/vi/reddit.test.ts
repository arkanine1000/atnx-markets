// node --test (through tsx): the pure parts of the Reddit source.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { groupByPhrase, momentumFromSamples, redditDue, redditLevel, redditPhrases, redditReading, rowToPost, INTERVAL_MS, type RedditPost } from './reddit';
import type { Sample } from './samples';

const T0 = Date.parse('2026-10-04T12:00:00Z');
const H = 3600 * 1000;
const D = 24 * H;
const post = (id: string, agoH: number, upvotes = 10, comments = 2): RedditPost => ({ id, createdAt: T0 - agoH * H, upvotes, comments });

test('redditPhrases: the name quoted, then multi-word aliases, at most three, no one-word alias', () => {
  assert.deepEqual(redditPhrases('Grand Theft Auto VI', ['GTA 6', 'GTA6', 'gta vi', 'Grand Theft Auto 6', 'extra one']), ['"Grand Theft Auto VI"', '"GTA 6"', '"gta vi"']);
  assert.deepEqual(redditPhrases('Meta', ['meta', 'Facebook']), ['"Meta"']);
  assert.deepEqual(redditPhrases(' "x" '), []);
});

test('rowToPost: a post row with a time; comments and timeless rows are skipped; score stands in for upvotes', () => {
  assert.deepEqual(rowToPost({ id: 't3_a', dataType: 'post', createdAt: '2026-10-04T10:00:00.000Z', upVotes: 5, commentsCount: 3 }), { id: 't3_a', createdAt: Date.parse('2026-10-04T10:00:00.000Z'), upvotes: 5, comments: 3 });
  assert.equal(rowToPost({ id: 't1_c', dataType: 'comment', createdAt: '2026-10-04T10:00:00.000Z' }), null);
  assert.equal(rowToPost({ id: 't3_b' }), null);
  assert.equal(rowToPost({ id: 't3_d', createdAt: '2026-10-04T10:00:00.000Z', score: '7' })?.upvotes, 7);
});

test('groupByPhrase: rows land under the phrase they name, quotes and case ignored; strays dropped', () => {
  const g = groupByPhrase([{ id: '1', searchTerm: 'grand theft auto vi' }, { id: '2', searchTerm: '"Grand Theft Auto VI"' }, { id: '3', searchTerm: 'other' }], ['"Grand Theft Auto VI"', '"GTA 6"']);
  assert.deepEqual(g.get('"Grand Theft Auto VI"')?.map((r) => r.id), ['1', '2']);
  assert.deepEqual(g.get('"GTA 6"'), []);
});

test('redditReading: a quiet week read in full: engagement over seven days, momentum today against the daily average', () => {
  const r = redditReading([post('a', 2, 100, 20), post('b', 30, 50, 10), post('c', 100, 10, 0), post('d', 150, 30, 5)], 10, T0);
  assert.equal(r.postsWeek, 4);
  assert.equal(r.postsDay, 1);
  assert.equal(r.capped, false);
  assert.equal(r.engagementWeek, 225);
  assert.equal(r.engagementPerDay, Math.round((225 / 168) * 24));
  assert.ok(r.momentum !== null && Math.abs(r.momentum - 1 / (4 / 7)) < 1e-9, `today 1 vs 4/7 a day: ${r.momentum}`);
});

test('redditReading: a busy phrase at the cap is read over the hours its posts span, no momentum yet', () => {
  const posts = Array.from({ length: 10 }, (_, i) => post(String(i), i * 0.5, 20, 5));
  const r = redditReading(posts, 10, T0);
  assert.equal(r.capped, true);
  assert.equal(r.spanH, 4.5);
  assert.equal(r.engagementPerDay, Math.round((250 / 4.5) * 24));
  assert.equal(Math.round(r.postsPerDay), Math.round((10 / 4.5) * 24));
  assert.equal(r.momentum, null);
});

test('redditReading: duplicates across phrases count once; posts outside the week are out; nothing is null', () => {
  const r = redditReading([post('a', 1), post('a', 1), post('old', 8 * 24)], 10, T0);
  assert.equal(r.postsWeek, 1);
  assert.equal(redditReading([], 10, T0).engagementPerDay, null);
});

test('momentumFromSamples: today against the reads one or two days back', () => {
  const samples: Sample[] = [
    { sampled_at: new Date(T0 - 24 * H).toISOString(), value: 0, meta: { posts_per_day: 4 } },
    { sampled_at: new Date(T0 - 48 * H).toISOString(), value: 0, meta: { posts_per_day: 2 } },
    { sampled_at: new Date(T0 - 5 * D).toISOString(), value: 0, meta: { posts_per_day: 100 } },
  ];
  assert.equal(momentumFromSamples(samples, 6, T0), 2);
  assert.equal(momentumFromSamples([], 6, T0), null);
});

test('redditLevel and redditDue', () => {
  assert.equal(redditLevel(0), 0);
  assert.equal(redditLevel(1), 100);
  assert.equal(redditLevel(1000), 700);
  assert.equal(redditDue(null, T0), true);
  assert.equal(redditDue({ source: 'reddit', level: 1, momentum: null, fetchedAt: new Date(T0 - 2 * H).toISOString() }, T0), false);
  assert.equal(redditDue({ source: 'reddit', level: 1, momentum: null, fetchedAt: new Date(T0 - INTERVAL_MS + 10 * 60_000).toISOString() }, T0), true);
});
