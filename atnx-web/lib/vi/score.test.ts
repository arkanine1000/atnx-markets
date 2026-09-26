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

// --- alias rule and the total-attention model (pre-switch) ---
import {
  CALIBRATION,
  attention,
  compositeMomentum,
  isVerifiableAlias,
  levelFromAttention,
  searchableAliases,
  sourceReading,
  youtubeReading,
  type SourceComponent,
} from './score';

const cmp = (source: SourceComponent['source'], level: number | null, meta: SourceComponent['meta'], momentum: number | null = null): SourceComponent => ({ source, level, momentum, fetchedAt: at, meta });

test('a one-word alias is searchable only when Wikipedia vouches for it', () => {
  const aliases = ['Trump', 'DJT', 'Donald J Trump', 'Trump TV', 'the'];
  const vouched = { own: 1, alias_ok: 'Trump,DJT' };
  assert.deepEqual(searchableAliases(aliases, vouched), ['Trump', 'DJT', 'Donald J Trump', 'Trump TV'], 'order kept, function word out');
  assert.deepEqual(searchableAliases(aliases, { own: 1, alias_ok: '' }), ['Donald J Trump', 'Trump TV']);
  assert.deepEqual(searchableAliases(aliases, { own: 0, alias_ok: 'Trump,DJT' }), ['Donald J Trump', 'Trump TV'], 'no own article, no vouching');
  assert.deepEqual(searchableAliases(aliases, undefined), ['Donald J Trump', 'Trump TV']);
  assert.deepEqual(searchableAliases(['Musk', 'Elon'], { own: 1, alias_ok: 'Trump' }), []);
  assert.deepEqual(searchableAliases(['trump'], { own: 1, alias_ok: 'Trump' }), ['trump'], 'case-insensitive');
});

test('isVerifiableAlias: plain single words only', () => {
  assert.equal(isVerifiableAlias('Trump'), true);
  assert.equal(isVerifiableAlias('the'), false);
  assert.equal(isVerifiableAlias('Donald Trump'), false, 'already searchable');
  assert.equal(isVerifiableAlias('@DolanDark'), false, 'already searchable');
  assert.equal(isVerifiableAlias(''), false);
});

test('sourceReading reads each source in its own unit', () => {
  assert.equal(sourceReading(cmp('x', 500, { rate_per_h: 10 })), 240);
  assert.equal(sourceReading(cmp('tiktok', 400, { videos_per_h: 2.5 })), 60);
  assert.equal(sourceReading(cmp('bluesky', 500, { posts_24h: '123+' })), 123);
  assert.equal(sourceReading(cmp('trends', 500, { ratio_to_benchmark: 1.5 })), 1.5);
  assert.equal(sourceReading(cmp('wikipedia', 600, { views_median_14d: 8000, views_latest: 20000 })), 8000, 'median for the level');
  assert.equal(sourceReading(cmp('wikipedia', 300, { views_median_14d: 0, views_latest: 400 })), 400, 'no median yet: latest');
  assert.equal(sourceReading(cmp('gdelt', 700, { articles_pct_7d: 0.05 })), 0.05);
  assert.equal(sourceReading(cmp('hn', 300, { hits_24h: 12 })), 12);
  assert.equal(sourceReading(cmp('youtube', 600, { views_7d: 1e7 })), 1e7);
  assert.equal(sourceReading(cmp('wikipedia', 0, { title: null })), 0, 'a known zero with no raw fields is a zero');
  assert.equal(sourceReading(cmp('x', null, {})), null, 'unknown');
  assert.equal(sourceReading(cmp('x', 500, {})), null, 'a level without its raw reading is unknown');
  assert.equal(sourceReading(cmp('dex', 500, { volume_24h_usd: 1e9 })), null, 'not scored');
});

test('youtubeReading takes the larger of name search and channel, and discounts a Shorts-first channel', () => {
  assert.equal(youtubeReading({ views_7d: 1e6, channel_views_7d: 4e6 }), 4e6);
  assert.equal(youtubeReading({ views_7d: 5e6, channel_views_7d: 4e6 }), 5e6);
  assert.equal(youtubeReading({ views_7d: 0, channel_views_7d: 24e6, channel_shorts_share: 1 }), 6e6, 'x0.25');
  assert.equal(youtubeReading({ views_7d: 0, channel_views_7d: 24e6, channel_shorts_share: 0.5 }), 24e6, 'under two thirds is long-form');
  assert.equal(youtubeReading({ views_7d: 0, channel_views_7d: 24e6, channel_shorts_share: null }), 24e6);
  assert.equal(youtubeReading({}), null);
});

test('attention sums k * r^q over the sources that answered; zeros add nothing', () => {
  const yt = cmp('youtube', 600, { views_7d: 1e7 });
  const x = cmp('x', 500, { rate_per_h: 10 });
  const zero = cmp('bluesky', 0, { posts_24h: 0 });
  const unknown = cmp('trends', null, {});
  const a = attention({ youtube: yt, x, bluesky: zero, trends: unknown });
  const uy = CALIBRATION.units.youtube!;
  const ux = CALIBRATION.units.x!;
  const expected = uy.k * Math.pow(1e7, uy.q) + ux.k * 240;
  assert.ok(Math.abs(a.A - expected) < 1e-6 * expected, `A ${a.A} vs ${expected}`);
  assert.deepEqual(a.answered.sort(), ['bluesky', 'x', 'youtube']);
  assert.equal(a.terms.bluesky, 0);
  assert.equal(a.topSource, 'youtube');
  assert.ok(Math.abs(a.shares.youtube! + a.shares.x! - 1) < 1e-9);
  assert.equal(attention({ youtube: yt, bluesky: zero }).A, attention({ youtube: yt }).A, 'a known zero changes nothing');
  assert.equal(attention({ trends: unknown }).answered.length, 0);
});

test('levelFromAttention: pointsPerDecade per tenfold from the zero point, clamped', () => {
  const P = CALIBRATION.pointsPerDecade;
  const A0 = 10 ** CALIBRATION.log10ZeroPoint;
  assert.equal(levelFromAttention(A0), 0);
  assert.equal(levelFromAttention(A0 * 10), Math.round(P));
  assert.equal(levelFromAttention(A0 * 100), Math.round(2 * P));
  assert.equal(levelFromAttention(A0 / 10), 0, 'under the zero point');
  assert.equal(levelFromAttention(0), 0);
  assert.equal(levelFromAttention(A0 * 1e9), 1000);
  const custom = { ...CALIBRATION, pointsPerDecade: 200, log10ZeroPoint: 5 };
  assert.equal(levelFromAttention(1e7, custom), 400);
});

test('compositeMomentum matches the old combine: weighted over sources with a baseline, 500 without', () => {
  const steady = cmp('x', 500, {}, 1);
  const spike = cmp('trends', 500, {}, 10);
  assert.equal(compositeMomentum([cmp('x', 500, {})]), 500);
  assert.equal(compositeMomentum([steady]), 500);
  assert.equal(compositeMomentum([spike]), 1000);
  const both = compositeMomentum([steady, spike]);
  const c = combine({ x: steady, trends: spike })!;
  assert.equal(Math.round(both), c.momentum);
});
