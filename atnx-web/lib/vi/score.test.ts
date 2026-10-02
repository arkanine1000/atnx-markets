// Run with: npm run test:vi
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { blendScores, combine, rescaleSeed, RAMP_MS, searchTerms, hasQualifier, isGenericTerm } from './score';

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
const xPosts = (viewsPerHour: number, momentum: number | null = null) => src('x', 500, { views_per_h: viewsPerHour }, momentum);
const term = (s: SourceComponent['source'], r: number) => CALIBRATION.units[s]!.k * Math.pow(r, CALIBRATION.units[s]!.q);

test('known zeros add nothing: a creator-only market keeps full credit', () => {
  const alone = combine({ youtube: yt(5e6) })!;
  const withZeros = combine({
    youtube: yt(5e6),
    x: src('x', 0, { views_per_h: 0 }),
    bluesky: src('bluesky', 0, { posts_24h: 0 }),
    trends: src('trends', 0, { ratio_to_benchmark: 0 }),
    wikipedia: src('wikipedia', 0, { title: null }),
  })!;
  assert.equal(withZeros.score, alone.score);
  assert.equal(withZeros.level, alone.level);
  assert.deepEqual(withZeros.sourcesPresent, ['youtube']);
  assert.equal(alone.level, Math.round(P * Math.log10(1 + term('youtube', 5e6) / A0)), 'P per decade above the zero point');
});

test('adding a source raises the level by P * log10 of the ratio of totals, with no presence step', () => {
  const one = combine({ youtube: yt(5e6) })!;
  const two = combine({ youtube: yt(5e6), x: xPosts(10) })!;
  const A1 = term('youtube', 5e6);
  const A2 = A1 + term('x', 240);
  void xPosts;
  assert.equal(two.level - one.level, Math.round(P * Math.log10(1 + A2 / A0)) - Math.round(P * Math.log10(1 + A1 / A0)));
  assert.ok(Math.abs(two.attention - A2) < 1e-6 * A2);
  assert.equal(two.topSource, 'youtube');
});

test('under the zero point is 0, far above it passes 1000, all zeros is 0, nothing answered is null', () => {
  assert.equal(combine({ youtube: yt(1) })!.level, 0, 'a single view rounds to 0');
  assert.ok(combine({ youtube: yt(1000) })!.level > 0 && combine({ youtube: yt(1000) })!.level < 20, 'a little attention reads a little');
  assert.ok(combine({ trends: src('trends', 900, { ratio_to_benchmark: 1e9 }) })!.score > 1000, 'no ceiling at 1000');
  const zeros = combine({ x: src('x', 0, { views_per_h: 0 }), trends: src('trends', 0, { ratio_to_benchmark: 0 }) })!;
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
  const steady = combine({ youtube: yt(5e6, 1), x: src('x', 0, { views_per_h: 0 }, 10) })!;
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
  assert.equal(c.level, Math.round(100 * Math.log10(1 + term('youtube', 5e6) / 1e6)));
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
  DEFAULT_CALIBRATION,
  applyCalibrationOverride,
  attention,
  compositeMomentum,
  shortsFactor,
  summarizeAttention,
  xReading,
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
  assert.equal(sourceReading(cmp('x', 500, { views_per_h: 1000, rate_per_h: 10 })), 24_000, 'impressions a day');
  assert.equal(sourceReading(cmp('x', 500, { rate_per_h: 10 })), 240 * CALIBRATION.xImpressionsPerPostFallback, 'an old reading stands in with posts x fallback');
  assert.equal(sourceReading(cmp('tiktok', 400, { views_per_h: 1000, videos_per_h: 2.5 })), 24_000, 'views a day');
  assert.equal(sourceReading(cmp('tiktok', 400, { videos_per_h: 2.5, views_total: 1e6, videos_total: 1000 })), 60 * 1000, 'old reading: videos x lifetime views per video');
  assert.equal(sourceReading(cmp('tiktok', 400, { videos_per_h: 2.5 })), null, 'old reading without totals: unknown');
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
  // Own-channel factor 1 here; the fitted default is tested below.
  const one = { ...CALIBRATION, ownChannelFactor: 1 };
  assert.equal(youtubeReading({ views_7d: 1e6, channel_views_7d: 4e6 }, one), 4e6);
  assert.equal(youtubeReading({ views_7d: 5e6, channel_views_7d: 4e6 }, one), 5e6);
  assert.equal(youtubeReading({ views_7d: 0, channel_views_7d: 24e6, channel_shorts_share: 1 }, one), 6e6, 'all Shorts: x0.25');
  assert.equal(youtubeReading({ views_7d: 0, channel_views_7d: 24e6, channel_shorts_share: 0.6 }, one), 24e6 * (1 - 0.75 * 0.6), 'linear in the share');
  assert.equal(youtubeReading({ views_7d: 0, channel_views_7d: 24e6, channel_shorts_share: 0 }, one), 24e6);
  assert.equal(youtubeReading({ views_7d: 0, channel_views_7d: 1e6 }), 1e6 * CALIBRATION.ownChannelFactor, 'the fitted factor by default');
  const half = { ...CALIBRATION, ownChannelFactor: 0.5 };
  assert.equal(youtubeReading({ views_7d: 0, channel_views_7d: 24e6, channel_shorts_share: 1 }, half), 3e6, 'own-channel factor after the Shorts discount');
  assert.equal(youtubeReading({ views_7d: 4e6, channel_views_7d: 6e6 }, half), 4e6, 'a halved channel can lose to the name search');
  assert.equal(youtubeReading({ views_7d: 0, channel_views_7d: 24e6, channel_shorts_share: null }, one), 24e6);
  assert.equal(youtubeReading({}), null);
});

test('attention sums k * r^q over the sources that answered; zeros add nothing', () => {
  const yt = cmp('youtube', 600, { views_7d: 1e7 });
  const x = cmp('x', 500, { views_per_h: 10 });
  const zero = cmp('bluesky', 0, { posts_24h: 0 });
  const unknown = cmp('trends', null, {});
  const a = attention({ youtube: yt, x, bluesky: zero, trends: unknown });
  const uy = CALIBRATION.units.youtube!;
  const ux = CALIBRATION.units.x!;
  const expected = uy.k * Math.pow(1e7, uy.q) + ux.k * Math.pow(240, ux.q);
  assert.ok(Math.abs(a.A - expected) < 1e-6 * expected, `A ${a.A} vs ${expected}`);
  assert.deepEqual(a.answered.sort(), ['bluesky', 'x', 'youtube']);
  assert.equal(a.terms.bluesky, 0);
  assert.equal(a.topSource, 'youtube');
  assert.ok(Math.abs(a.shares.youtube! + a.shares.x! - 1) < 1e-9);
  assert.equal(attention({ youtube: yt, bluesky: zero }).A, attention({ youtube: yt }).A, 'a known zero changes nothing');
  assert.equal(attention({ trends: unknown }).answered.length, 0);
});

test('levelFromAttention: pointsPerDecade per tenfold from the zero point, floored at 0, no ceiling', () => {
  const P = CALIBRATION.pointsPerDecade;
  const A0 = 10 ** CALIBRATION.log10ZeroPoint;
  assert.equal(levelFromAttention(A0 * 10), Math.round(P * Math.log10(11)));
  assert.equal(levelFromAttention(A0 * 100), Math.round(P * Math.log10(101)));
  assert.equal(levelFromAttention(0), 0);
  assert.equal(levelFromAttention(A0 * 1e9), Math.round(P * Math.log10(1 + 1e9)), 'keeps counting past 1000');
  assert.equal(levelFromAttention(A0 * 10 ** (1000 / P)), 1000, '1000 is a point on the scale, not its end');
  const custom = { ...CALIBRATION, pointsPerDecade: 200, log10ZeroPoint: 5 };
  assert.equal(levelFromAttention(1e7, custom), Math.round(200 * Math.log10(101)));
});

test('compositeMomentum matches the old combine: weighted over sources with a baseline, 500 without', () => {
  const steady = cmp('x', 500, { views_per_h: 10 }, 1);
  const spike = cmp('trends', 500, { ratio_to_benchmark: 1 }, 10);
  assert.equal(compositeMomentum([cmp('x', 500, { views_per_h: 10 })]), 500);
  assert.equal(compositeMomentum([steady]), 500);
  assert.equal(compositeMomentum([spike]), 1000);
  // Weighted by share: a spike on a source that is nearly all of the total
  // moves the momentum nearly all the way; on a tiny source, hardly.
  assert.ok(compositeMomentum([steady, spike], { x: 0.02, trends: 0.98 }) > 980);
  assert.ok(compositeMomentum([steady, spike], { x: 0.98, trends: 0.02 }) < 520);
  const c = combine({ x: steady, trends: spike })!;
  assert.equal(c.momentum, Math.round(compositeMomentum([steady, spike], c.shares)));
  assert.equal(Math.round(compositeMomentum([steady, spike])), Math.round(compositeMomentum([steady, spike], undefined)), 'WEIGHTS fallback');
});

test('summarizeAttention: total, rounded shares, the top source, who answered and who saw', () => {
  const sum = summarizeAttention({
    youtube: cmp('youtube', 600, { views_7d: 1e7 }),
    x: cmp('x', 500, { views_per_h: 10 }),
    bluesky: cmp('bluesky', 0, { posts_24h: 0 }),
    trends: cmp('trends', null, {}),
  })!;
  const uy = CALIBRATION.units.youtube!;
  const ux = CALIBRATION.units.x!;
  assert.equal(sum.total, Math.round(uy.k * Math.pow(1e7, uy.q) + ux.k * Math.pow(240, ux.q)));
  assert.equal(sum.top, 'youtube');
  assert.deepEqual(sum.answered.sort(), ['bluesky', 'x', 'youtube']);
  assert.deepEqual(sum.seeing.sort(), ['x', 'youtube']);
  assert.ok(Math.abs(sum.shares.youtube! + sum.shares.x! - 1) < 0.002);
  assert.equal(sum.shares.bluesky, undefined, 'a zero has no share');
  assert.equal(summarizeAttention(null), null);
  assert.equal(summarizeAttention({ trends: cmp('trends', null, {}) }), null);
});

test('shortsFactor is linear in the Shorts share and 1 when unknown', () => {
  assert.equal(shortsFactor(1), 0.25);
  assert.equal(shortsFactor(0), 1);
  assert.equal(shortsFactor(0.6), 1 - 0.75 * 0.6);
  assert.equal(shortsFactor(null), 1);
  assert.equal(shortsFactor(undefined), 1);
  assert.equal(shortsFactor(2), 0.25, 'clamped');
});

test('applyCalibrationOverride merges an env JSON over the defaults', () => {
  const base = DEFAULT_CALIBRATION;
  assert.equal(applyCalibrationOverride(base, undefined), base);
  assert.equal(applyCalibrationOverride(base, '  '), base);
  assert.equal(applyCalibrationOverride(base, '{not json'), base, 'malformed JSON is ignored');
  const o = applyCalibrationOverride(base, JSON.stringify({ pointsPerDecade: 300, units: { x: { k: 1000 }, dex: { k: 1, q: 1 } } }));
  assert.equal(o.pointsPerDecade, 300);
  assert.equal(o.log10ZeroPoint, base.log10ZeroPoint, 'untouched fields keep their defaults');
  assert.equal(o.units.x!.k, 1000);
  assert.equal(o.units.x!.q, base.units.x!.q, 'a unit override keeps the other field');
  assert.deepEqual(o.units.dex, { k: 1, q: 1 }, 'a null unit can be switched on');
  assert.equal(o.units.youtube, base.units.youtube);
  assert.equal(o.ownChannelFactor, base.ownChannelFactor);
  assert.equal(applyCalibrationOverride(base, JSON.stringify({ ownChannelFactor: 0.4 })).ownChannelFactor, 0.4);
  assert.match(o.version, /\+env$/);
  const named = applyCalibrationOverride(base, JSON.stringify({ version: 'sum-v2' }));
  assert.equal(named.version, 'sum-v2');
});

test('levelFromAttention bends to 0 below the zero point instead of cutting off', () => {
  const P = CALIBRATION.pointsPerDecade;
  const A0 = 10 ** CALIBRATION.log10ZeroPoint;
  assert.equal(levelFromAttention(A0 / 10), Math.round(P * Math.log10(1.1)));
  assert.equal(levelFromAttention(A0), Math.round(P * Math.log10(2)));
  assert.ok(Math.abs(levelFromAttention(A0 * 100) - 2 * P) <= 1.5, 'far above, the plain log');
});

test('xReading takes the larger of talk impressions and the own account reach, factored', () => {
  const one = { ...CALIBRATION, ownChannelFactor: 0.5 };
  assert.equal(xReading({ views_per_h: 1000 }, one), 24_000, 'talk only');
  assert.equal(xReading({ views_per_h: 1000, own_views_per_h: 100_000 }, one), 100_000 * 24 * 0.5, 'own reach wins, factored');
  assert.equal(xReading({ views_per_h: 1000, own_views_per_h: 1500 }, one), 24_000, 'talk wins');
  assert.equal(xReading({ own_views_per_h: 100_000 }, one), 100_000 * 24 * 0.5, 'own reach alone (no talk read yet)');
  assert.equal(xReading({ rate_per_h: 10 }, one), 240 * one.xImpressionsPerPostFallback, 'old talk reading falls back');
  assert.equal(xReading({}, one), null);
  assert.equal(xReading({ own_views_per_h: null, views_per_h: null }, one), null);
  // A known-zero talk slot with own reach scores the own reach.
  const c = combine({ x: { source: 'x', level: 0, momentum: null, fetchedAt: at, meta: { own_views_per_h: 100_000 } } }, { calibration: one })!;
  assert.ok(c.level > 0);
  assert.deepEqual(c.sourcesPresent, ['x']);
});

test('searchTerms: a work named by an everyday word searches its aliases only; people, brands and exact articles keep the name', () => {
  const qualified = { own: 1, match: 'qualified', title: 'Cars (film)' };
  assert.deepEqual(searchTerms('Cars', ['Cars Film', 'Pixar Cars', 'Lightning McQueen'], { wiki: qualified, entityType: 'other', category: 'film_tv' }), { term: 'Cars Film', aliases: ['Pixar Cars', 'Lightning McQueen'] });
  assert.deepEqual(searchTerms('Meta', ['Meta Platforms'], { wiki: { own: 1, match: 'qualified', title: 'Meta Platforms' }, entityType: 'brand', category: 'tech' }), { term: 'Meta', aliases: ['Meta Platforms'] }, 'a brand keeps its bare name');
  assert.deepEqual(searchTerms('Cars', ['Pixar Cars'], { wiki: { own: 1, match: 'exact', title: 'Cars' }, entityType: 'other', category: 'film_tv' }), { term: 'Cars', aliases: ['Pixar Cars'] }, 'an exact article means the bare name is the subject');
  assert.deepEqual(searchTerms('Cars', [], { wiki: qualified, entityType: 'other', category: 'film_tv' }), { term: 'Cars', aliases: [] }, 'nothing to fall back on');
  assert.deepEqual(searchTerms('Cars', ['Pixar Cars'], { wiki: null, entityType: 'other', category: 'film_tv' }), { term: 'Cars', aliases: ['Pixar Cars'] }, 'no Wikipedia reading yet');
  assert.deepEqual(searchTerms('Verity', ['Minecraft Verity'], { wiki: qualified, entityType: 'other', category: 'gaming' }), { term: 'Minecraft Verity', aliases: [] });
});

test('searchTerms and hasQualifier: a name the model qualified searches its aliases whatever the type', () => {
  assert.equal(hasQualifier('Cars (2006 film)'), true);
  assert.equal(hasQualifier('Wednesday (TV series)'), true);
  assert.equal(hasQualifier('Verity (Minecraft ARG)'), true);
  assert.equal(hasQualifier('MrBeast'), false);
  assert.equal(hasQualifier('(500) Days of Summer'), false, 'a leading parenthesis is part of the title');
  assert.deepEqual(searchTerms('Hello', ['Hello Adele', 'Adele Hello'], { wiki: null, entityType: 'other', category: 'music', name: 'Hello (Adele song)' }), { term: 'Hello Adele', aliases: ['Adele Hello'] });
  assert.deepEqual(searchTerms('Hello', [], { wiki: null, entityType: 'other', category: 'music', name: 'Hello (Adele song)' }), { term: 'Hello', aliases: [] }, 'no alias to fall back on');
  assert.deepEqual(searchTerms('Drake', ['Drake rapper'], { wiki: null, entityType: 'person', category: 'music', name: 'Drake (rapper)' }), { term: 'Drake rapper', aliases: [] }, 'a person too, when the model qualified it');
});

test('isGenericTerm: one word is generic unless Wikipedia owns it, or a meme coined it and Wikipedia has nothing', () => {
  assert.equal(isGenericTerm('Donald Trump', null), false, 'two words never generic');
  assert.equal(isGenericTerm('The', { own: 1, title: 'The' }), true, 'a function word, article or not');
  assert.equal(isGenericTerm('Trollface', { own: 1, title: 'Trollface', from: 'term' }), false);
  assert.equal(isGenericTerm('Meta', { own: 1, title: 'Meta Platforms', from: 'term' }), false);
  assert.equal(isGenericTerm('Verity', { own: 0, title: 'Verity', from: 'term' }), true, 'a namesake article');
  assert.equal(isGenericTerm('Verity', { own: 0, title: 'Verity', from: 'term' }, { entityType: 'meme' }), true, 'a namesake article, even for a meme');
  // Searched and found nothing: a coined meme name is not generic; anything else still is.
  const nothing = { own: 0, title: null, from: 'term' };
  assert.equal(isGenericTerm('Nosfercatu', nothing, { entityType: 'meme' }), false);
  assert.equal(isGenericTerm('Whimsy', nothing, { entityType: 'trend' }), true, 'an everyday word Wikipedia happens not to title');
  assert.equal(isGenericTerm('ATNX', nothing, { entityType: 'brand' }), true);
  assert.equal(isGenericTerm('Nosfercatu', nothing), true, 'no type given');
  assert.equal(isGenericTerm('Nosfercatu', { own: 0, title: null, from: 'alias' }, { entityType: 'meme' }), true, 'resolved through an alias says nothing about the word');
  assert.equal(isGenericTerm('Nosfercatu', { own: 0, title: null }, { entityType: 'meme' }), false, 'a reading without from is a term reading');
  assert.equal(isGenericTerm('Nosfercatu', null, { entityType: 'meme' }), true, 'no reading at all: nothing is known');
  assert.equal(isGenericTerm('Nosfercatu', { title: null }, { entityType: 'meme' }), true, 'an old reading without own and without a title');
  assert.equal(isGenericTerm('Nujabes', { title: 'Nujabes' }), false, 'an old reading: title compared by name');
});
