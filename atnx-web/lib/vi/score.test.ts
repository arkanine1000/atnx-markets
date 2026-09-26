// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blendScores, combine, rescaleSeed, RAMP_MS } from './score';

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
const P = CALIBRATION.pointsPerDecade;
const A0 = 10 ** CALIBRATION.log10ZeroPoint;
const src = (source: SourceComponent['source'], level: number | null, meta: SourceComponent['meta'], momentum: number | null = null): SourceComponent => ({ source, level, momentum, fetchedAt: at, meta });
const yt = (views: number, momentum: number | null = null) => src('youtube', 560, { views_7d: views }, momentum);
const xPosts = (perHour: number, momentum: number | null = null) => src('x', 500, { rate_per_h: perHour }, momentum);
const term = (s: SourceComponent['source'], r: number) => CALIBRATION.units[s]!.k * Math.pow(r, CALIBRATION.units[s]!.q);

test('known zeros add nothing: a creator-only market keeps full credit', () => {
  const alone = combine({ youtube: yt(5e6) })!;
  const withZeros = combine({
    youtube: yt(5e6),
    x: src('x', 0, { rate_per_h: 0 }),
    bluesky: src('bluesky', 0, { posts_24h: 0 }),
    trends: src('trends', 0, { ratio_to_benchmark: 0 }),
    wikipedia: src('wikipedia', 0, { title: null }),
  })!;
  assert.equal(withZeros.score, alone.score);
  assert.equal(withZeros.level, alone.level);
  assert.deepEqual(withZeros.sourcesPresent, ['youtube']);
  assert.equal(alone.level, Math.round(P * Math.log10(term('youtube', 5e6) / A0)), 'P per decade above the zero point');
});

test('adding a source raises the level by P * log10 of the ratio of totals, with no presence step', () => {
  const one = combine({ youtube: yt(5e6) })!;
  const two = combine({ youtube: yt(5e6), x: xPosts(10) })!;
  const A1 = term('youtube', 5e6);
  const A2 = A1 + term('x', 240);
  assert.equal(two.level - one.level, Math.round(P * Math.log10(A2 / A0)) - Math.round(P * Math.log10(A1 / A0)));
  assert.ok(Math.abs(two.attention - A2) < 1e-6 * A2);
  assert.equal(two.topSource, 'youtube');
});

test('under the zero point is 0, far above it is 1000, all zeros is 0, nothing answered is null', () => {
  assert.equal(combine({ youtube: yt(1000) })!.level, 0);
  assert.equal(combine({ trends: src('trends', 900, { ratio_to_benchmark: 1e9 }) })!.score, 1000);
  const zeros = combine({ x: src('x', 0, { rate_per_h: 0 }), trends: src('trends', 0, { ratio_to_benchmark: 0 }) })!;
  assert.equal(zeros.score, 0);
  assert.deepEqual(zeros.sourcesPresent, []);
  assert.equal(combine({ x: src('x', null, {}) }), null);
  assert.equal(combine({}), null);
});

test('momentum scales the level: x0.65 at a collapse, x1 steady, x1.35 at a 10x spike', () => {
  const level = combine({ youtube: yt(5e6) })!.level;
  assert.equal(combine({ youtube: yt(5e6, 1) })!.score, Math.round(level * 1));
  assert.equal(combine({ youtube: yt(5e6, 10) })!.score, Math.round(level * 1.35));
  assert.equal(combine({ youtube: yt(5e6, 0.1) })!.score, Math.round(level * 0.65));
  assert.equal(combine({ youtube: yt(5e6) })!.momentum, 500, 'no baseline anywhere: steady');
});

test('momentum counts only sources that see something', () => {
  const steady = combine({ youtube: yt(5e6, 1), x: src('x', 0, { rate_per_h: 0 }, 10) })!;
  assert.equal(steady.momentum, 500, 'a zero source with a spike momentum does not count');
});

test('dex is not scored: dex-only is null and dex changes nothing', () => {
  assert.equal(combine({ dex: src('dex', 600, { volume_24h_usd: 1e9 }, 2) }), null);
  const without = combine({ youtube: yt(5e6) })!;
  const withDex = combine({ youtube: yt(5e6), dex: src('dex', 600, { volume_24h_usd: 1e9 }, 2) })!;
  assert.equal(withDex.score, without.score);
  assert.deepEqual(withDex.sourcesPresent, ['youtube']);
});

test('a calibration override is honoured', () => {
  const cal = { ...CALIBRATION, pointsPerDecade: 100, log10ZeroPoint: 6 };
  const c = combine({ youtube: yt(5e6) }, { calibration: cal })!;
  assert.equal(c.level, Math.round(100 * (Math.log10(term('youtube', 5e6)) - 6)));
});

test('rescaleSeed moves the Trends share only and clamps', () => {
  const series = [
    { date: '2026-09-20', value: 300 }, // 0.1x of today's ratio
    { date: '2026-09-21', value: 0 },
    { date: '2026-09-22', value: 500 }, // today
  ];
  const out = rescaleSeed(series, 600, 0.5);
  assert.equal(out[2].value, 600, 'today is the score');
  assert.equal(out[0].value, Math.round(600 + P * Math.log10(1 + 0.5 * (0.1 - 1))));
  assert.equal(out[1].value, Math.round(600 + P * Math.log10(1 - 0.5)));
  assert.deepEqual(rescaleSeed(series, 600, 0), [], 'no Trends share: nothing to seed');
  assert.deepEqual(rescaleSeed([{ date: 'd', value: 0 }], 600, 0.5), [], 'Trends reads nothing today');
  assert.equal(rescaleSeed(series, 20, 1)[1].value, 0, 'clamped at 0');
});

// --- alias rule and the total-attention model (pre-switch) ---
import {
  CALIBRATION,
  attention,
  compositeMomentum,
  summarizeAttention,
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
  const steady = cmp('x', 500, { rate_per_h: 10 }, 1);
  const spike = cmp('trends', 500, { ratio_to_benchmark: 1 }, 10);
  assert.equal(compositeMomentum([cmp('x', 500, { rate_per_h: 10 })]), 500);
  assert.equal(compositeMomentum([steady]), 500);
  assert.equal(compositeMomentum([spike]), 1000);
  const both = compositeMomentum([steady, spike]);
  const c = combine({ x: steady, trends: spike })!;
  assert.equal(Math.round(both), c.momentum);
});

test('summarizeAttention: total, rounded shares, the top source, who answered and who saw', () => {
  const sum = summarizeAttention({
    youtube: cmp('youtube', 600, { views_7d: 1e7 }),
    x: cmp('x', 500, { rate_per_h: 10 }),
    bluesky: cmp('bluesky', 0, { posts_24h: 0 }),
    trends: cmp('trends', null, {}),
  })!;
  const uy = CALIBRATION.units.youtube!;
  const ux = CALIBRATION.units.x!;
  assert.equal(sum.total, Math.round(uy.k * Math.pow(1e7, uy.q) + ux.k * 240));
  assert.equal(sum.top, 'youtube');
  assert.deepEqual(sum.answered.sort(), ['bluesky', 'x', 'youtube']);
  assert.deepEqual(sum.seeing.sort(), ['x', 'youtube']);
  assert.ok(Math.abs(sum.shares.youtube! + sum.shares.x! - 1) < 0.002);
  assert.equal(sum.shares.bluesky, undefined, 'a zero has no share');
  assert.equal(summarizeAttention(null), null);
  assert.equal(summarizeAttention({ trends: cmp('trends', null, {}) }), null);
});
