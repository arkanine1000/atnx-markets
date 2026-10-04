// node --test (through tsx): the VI explainer's pure parts with a pinned
// clock, hand-built breakdowns and the default calibration.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  attributeStep,
  coverage,
  cronHealth,
  diagnoseMarket,
  explainComposite,
  explainMoves,
  explainSource,
  fmtAge,
  fmtCount,
  fmtPct,
  fmtUsd,
  freshness,
  lastReadCost,
  spendToday,
  type Prices,
  type Snapshot,
  type ViMarketInput,
} from './explain';
import { attention, combine, type Components, type SourceComponent, type SourceName } from './score';
import { scoringComponents } from '../signals';

const T0 = Date.parse('2026-10-05T12:00:00Z');
const MIN = 60_000;
const H = 3600_000;
const at = (agoMs: number) => new Date(T0 - agoMs).toISOString();
const PRICES: Prices = { usdPerTweet: 0.00015, usdPerRequestMin: 0.00015, usdPerHashtag: 0.0005, usdPerSearchResult: 0.004, resultsPerSearch: 10, usdPerPostRead: { tiktok: 0.0003, instagram: 0.0027, x: 0.00015 } };

function c(source: SourceName, over: Partial<SourceComponent> & { agoMs?: number } = {}): SourceComponent {
  const { agoMs = 10 * MIN, ...rest } = over;
  return { source, level: 300, momentum: null, fetchedAt: at(agoMs), ...rest };
}
const tiktok = (viewsPerH: number, over: Partial<SourceComponent> & { agoMs?: number } = {}) => c('tiktok', { meta: { hashtag: 'halloween', views_per_h: viewsPerH, videos_per_h: 10, queried: 1 }, ...over });
const trends = (ratio: number, over: Partial<SourceComponent> & { agoMs?: number } = {}) => c('trends', { meta: { ratio_to_benchmark: ratio, benchmark: 'sudoku', keyword: 'halloween' }, ...over });
const bluesky = (posts: number | string, over: Partial<SourceComponent> & { agoMs?: number } = {}) => c('bluesky', { meta: { posts_24h: posts, posts_1h: 3 }, ...over });
const x = (viewsPerH: number, over: Partial<SourceComponent> & { agoMs?: number } = {}) => c('x', { meta: { views_per_h: viewsPerH, tweets: 42, requests: 3 }, ...over });
const youtube = (views7d: number, over: Partial<SourceComponent> & { agoMs?: number } = {}) => c('youtube', { meta: { views_7d: views7d, video_count: 12, top_views: 900_000 }, ...over });

function market(components: Components, over: Partial<ViMarketInput> = {}): ViMarketInput {
  return { id: 'm1', name: 'Halloween', entityType: 'event', category: 'memes', currentVi: 500, viState: 'live', viLastUpdated: at(5 * MIN), aliases: [], components, ...over };
}

test('formatters', () => {
  assert.equal(fmtCount(999), '999');
  assert.equal(fmtCount(1500), '1.5k');
  assert.equal(fmtCount(900_000), '900k');
  assert.equal(fmtCount(1_234_567), '1.2M');
  assert.equal(fmtCount(0.42), '0.42');
  assert.equal(fmtPct(0.004), '<1%');
  assert.equal(fmtPct(0.31), '31%');
  assert.equal(fmtAge(40 * MIN), '40 min');
  assert.equal(fmtAge(3 * H), '3 h');
  assert.equal(fmtAge(3 * 24 * H), '3 d');
  assert.equal(fmtUsd(0.0005), '$0.0005');
  assert.equal(fmtUsd(1.2), '$1.20');
});

test('freshness: each cadence at its edges; a young post market hourly; unknown; expiring', () => {
  assert.equal(freshness('trends', trends(1, { agoMs: 20 * MIN }), T0).state, 'fresh');
  assert.equal(freshness('trends', trends(1, { agoMs: 60 * MIN }), T0).state, 'late');
  assert.equal(freshness('trends', trends(1, { agoMs: 90 * MIN }), T0).state, 'stale');
  assert.equal(freshness('x', x(1, { agoMs: 3 * H + 10 * MIN }), T0).state, 'fresh');
  assert.equal(freshness('x', x(1, { agoMs: 6 * H }), T0).state, 'late');
  assert.equal(freshness('x', x(1, { agoMs: 8 * H }), T0).state, 'stale');
  const young = c('post', { meta: { views_per_day: 10, posts_read: 1, first_read_at: at(2 * H) }, agoMs: 70 * MIN });
  assert.equal(freshness('post', young, T0).state, 'fresh');
  assert.equal(freshness('post', { ...young, fetchedAt: at(2.5 * H) }, T0).state, 'late');
  const mature = c('post', { meta: { views_per_day: 10, posts_read: 1, first_read_at: at(3 * 24 * H) }, agoMs: 2.5 * H });
  assert.equal(freshness('post', mature, T0).state, 'fresh');
  assert.equal(freshness('x', x(1, { level: null, agoMs: MIN }), T0).state, 'unknown');
  assert.equal(freshness('wikipedia', c('wikipedia', { agoMs: 41 * H }), T0).state, 'expiring');
});

test('explainSource: one sentence per source with its unit and number', () => {
  const comps: Components = { tiktok: tiktok(50_000, { momentum: 2.1 }), trends: trends(0.42), bluesky: bluesky('1000+'), x: x(50_000, { meta: { views_per_h: 50_000, own_views_per_h: 1000, tweets: 42, requests: 3 } }), youtube: youtube(2_300_000, { meta: { views_7d: 2_300_000, video_count: 12, top_views: 900_000, channel_views_7d: 5_100_000, channel_shorts_share: 0.4 } }), dex: c('dex', { meta: { volume_24h_usd: 1_200_000, chain: 'solana', symbol: 'HALO' } }), wikipedia: c('wikipedia', { meta: { title: 'Halloween', views_median_14d: 4100, views_latest: 5200, latest_date: '2026-10-03' } }), hn: c('hn', { level: null, agoMs: 2 * H }) };
  const atn = attention(comps);
  const ctx = { shares: atn.shares, terms: atn.terms, now: T0, prices: PRICES };
  const s = (name: SourceName) => explainSource(comps[name]!, ctx);
  assert.match(s('tiktok').sentence, /TikTok hashtag: 1\.2M views a day under #halloween · 2\.1× its baseline · \d+% of this market's attention · read 10 min ago \(due every 3 h\) · last read ≈ \$0\.0005/);
  assert.match(s('trends').sentence, /searched at 0\.42× the benchmark query 'sudoku' \(as 'halloween'\)/);
  assert.match(s('bluesky').sentence, /1\.0k\+ \(capped\) posts in 24 h \(3 in the last hour\)/);
  assert.match(s('x').sentence, /1\.2M impressions a day on posts about the name; own account 24k a day, counted at 69%/);
  assert.match(s('youtube').sentence, /2\.3M views this week across 12 videos \(top 900k\); own channel 5\.1M a week, 40% Shorts, which scores/);
  assert.match(s('dex').sentence, /\$1200000\.00 traded in 24 h on solana \(HALO\); not scored \(uncalibrated\)/);
  assert.equal(s('dex').status, 'zero');
  assert.match(s('wikipedia').sentence, /'Halloween' gets 4\.1k views a day \(14-day median; 5\.2k on 2026-10-03\)/);
  assert.equal(s('hn').status, 'unknown');
  assert.match(s('hn').sentence, /Hacker News: did not answer on the last read \(2 h ago\); not counted\./);
  assert.match(explainSource(trends(0, { meta: { ratio_to_benchmark: 0, benchmark: 'sudoku', below_resolution: 1 } }), ctx).sentence, /below Google Trends' resolution/);
});

test('lastReadCost per source', () => {
  assert.equal(lastReadCost(x(1, { meta: { tweets: 400, requests: 2 } }), PRICES).usd, 400 * 0.00015);
  assert.equal(lastReadCost(x(1, { meta: { tweets: 1, requests: 2 } }), PRICES).usd, 2 * 0.00015);
  assert.equal(lastReadCost(tiktok(1, { meta: { queried: 3 } }), PRICES).usd, 3 * 0.0005);
  const searched = c('tiktok_search', { meta: { views_per_day: 1, posts_read: 10, searched_at: at(H) } });
  assert.equal(lastReadCost(searched, PRICES).usd, 10 * 0.004 + 10 * 0.0003);
  assert.equal(lastReadCost(c('post', { meta: { posts_read: 4 } }), PRICES).usd, 4 * 0.0003);
  assert.equal(lastReadCost(c('wikipedia'), PRICES).usd, 0);
});

test('explainComposite: equals combine over the scored breakdown; neutral momentum; the meme-Wikipedia rule', () => {
  const comps: Components = { tiktok: tiktok(50_000, { momentum: 2 }), trends: trends(0.42, { momentum: 1 }), wikipedia: c('wikipedia', { level: 0, meta: { views_median_14d: 0 } }) };
  const e = explainComposite(comps, { category: 'memes', currentVi: 500, viState: 'live', latestRaw: null });
  assert.equal(e.score, combine(scoringComponents(comps, { category: 'memes', creator: true }).components)?.score);
  assert.ok(e.sentences.some((s) => s.startsWith('Level ')));
  assert.ok(e.sentences.some((s) => /no article for this meme/.test(s)), 'the Wikipedia note');
  const neutral = explainComposite({ tiktok: tiktok(50_000) }, { category: 'memes', currentVi: 500, viState: 'live', latestRaw: null });
  assert.equal(neutral.factor, 1);
  assert.ok(neutral.sentences.some((s) => /momentum is neutral/.test(s)));
});

test('diagnoseMarket: one fixture per flag, and a clean market', () => {
  const opts = { now: T0, prices: PRICES };
  const cleanComps: Components = { tiktok: tiktok(50_000, { momentum: 1.2 }), trends: trends(0.1, { momentum: 1 }) };
  const clean = diagnoseMarket(market(cleanComps, { name: 'Skibidi Toilet', currentVi: combine(cleanComps)!.score }), opts);
  assert.deepEqual(clean.flags, []);
  assert.equal(clean.topSource, 'trends');
  assert.ok(diagnoseMarket(market({ tiktok: tiktok(0) }, { currentVi: 0 }), opts).flags.includes('zero'));
  assert.ok(diagnoseMarket(market({ tiktok: tiktok(50_000) }, { viState: 'scoring' }), opts).flags.includes('scoring'));
  assert.ok(diagnoseMarket(market({ tiktok: tiktok(50_000), trends: trends(0.001) }), opts).flags.includes('dominant'));
  assert.ok(diagnoseMarket(market({ tiktok: tiktok(50_000) }, { name: 'Apple', entityType: 'brand' }), opts).flags.includes('generic'));
  assert.ok(diagnoseMarket(market({ tiktok: tiktok(50_000) }), opts).flags.includes('no_momentum'));
  assert.ok(diagnoseMarket(market({ tiktok: tiktok(50_000, { agoMs: 9 * H }) }), opts).flags.includes('stale'));
  assert.ok(diagnoseMarket(market({ tiktok: tiktok(50_000) }, { currentVi: 100 }), opts).flags.includes('catching_up'));
});

test('coverage over three markets', () => {
  const rows = coverage([market({ tiktok: tiktok(50_000), x: x(1, { level: null }) }), market({ tiktok: tiktok(0, { agoMs: 9 * H }) }), market({})], T0);
  const tk = rows.find((r) => r.source === 'tiktok')!;
  assert.equal(tk.answering, 2);
  assert.equal(tk.seeing, 1);
  assert.equal(tk.notAsked, 1);
  assert.equal(tk.stale, 1);
  const xx = rows.find((r) => r.source === 'x')!;
  assert.equal(xx.unknown, 1);
  assert.equal(xx.notAsked, 2);
});

function snap(agoH: number, comps: Components, raw: number | null = null): Snapshot {
  const score = combine(comps)?.score ?? 0;
  return { at: at(agoH * H), components: comps, raw: raw ?? score, vi: score, attention: null };
}

test('attributeStep: the points sum to the recomputed change and land on the source that moved', () => {
  const base: Components = { tiktok: tiktok(10_000, { momentum: 1 }), x: x(10_000, { momentum: 1 }) };
  const after: Components = { tiktok: tiktok(60_000, { momentum: 1 }), x: x(10_000, { momentum: 1 }) };
  const m = attributeStep(snap(2, base), snap(1, after), { category: 'memes' });
  const sum = m.contributions.reduce((s, d) => s + d.pts, 0);
  assert.ok(Math.abs(sum - m.dScore) < 1e-6, `sum ${sum} vs ${m.dScore}`);
  assert.equal(m.contributions[0].source, 'tiktok');
  assert.equal(m.contributions[0].change, 'changed');
  assert.ok(Math.abs(m.contributions.find((d) => d.source === 'x')!.pts) < 1e-9, 'X did not move');
  assert.match(m.sentence, /TikTok hashtag 240k → 1\.4M \(share \d+% → \d+%\) \+\d+/);
  // Momentum only.
  const mom = attributeStep(snap(2, base), snap(1, { tiktok: tiktok(10_000, { momentum: 3 }), x: x(10_000, { momentum: 1 }) }), { category: 'memes' });
  assert.ok(mom.contributions[0].momentumPts > 0 && Math.abs(mom.contributions[0].levelPts) < 1e-9);
  assert.match(mom.sentence, /momentum 1\.0× → 3\.0×/);
  // A source appears and one drops.
  const swap = attributeStep(snap(2, base), snap(1, { tiktok: tiktok(10_000, { momentum: 1 }), trends: trends(0.5) }), { category: 'memes' });
  assert.equal(swap.contributions.find((d) => d.source === 'trends')!.change, 'new');
  assert.equal(swap.contributions.find((d) => d.source === 'x')!.change, 'dropped');
  assert.ok(Math.abs(swap.contributions.reduce((s, d) => s + d.pts, 0) - swap.dScore) < 1e-6);
  // Offsetting changes.
  const off = attributeStep(snap(2, base), snap(1, { tiktok: tiktok(40_000, { momentum: 1 }), x: x(2_500, { momentum: 1 }) }), { category: 'memes' });
  const tk = off.contributions.find((d) => d.source === 'tiktok')!.pts;
  const xx = off.contributions.find((d) => d.source === 'x')!.pts;
  assert.ok(tk > 0 && xx < 0);
  assert.ok(Math.abs(tk + xx - off.dScore) < 1e-6);
  // Residual: the stored raw moved more than the readings explain.
  const res = attributeStep(snap(2, base, 400), snap(1, after, 700), { category: 'memes' });
  assert.ok(res.residual !== null && Math.abs(res.residual) >= 3);
  assert.match(res.sentence, /points not explained by readings/);
  // No momentum anywhere: no momentum points.
  const nm = attributeStep(snap(2, { tiktok: tiktok(10_000) }), snap(1, { tiktok: tiktok(60_000) }), { category: 'memes' });
  assert.ok(nm.contributions.every((d) => d.momentumPts === 0));
});

test('explainMoves: threshold, merging, gaps, headline, empty cases', () => {
  const comps = (v: number) => ({ tiktok: tiktok(v, { momentum: 1 }), x: x(10_000, { momentum: 1 }) });
  const snaps = [snap(26, comps(10_000)), snap(24, comps(10_000)), snap(23, comps(20_000)), snap(22, comps(40_000)), snap(21, comps(40_100)), snap(17, comps(40_100)), snap(16, comps(5_000))];
  const r = explainMoves(snaps, { windowStartMs: T0 - 25 * H, category: 'memes', now: T0 });
  assert.ok(r.moves.length >= 2);
  assert.equal(r.moves[0].to, at(16 * H), 'newest first');
  const up = r.moves.find((m) => (m.dRaw ?? 0) > 0)!;
  assert.equal(up.from, at(24 * H), 'the two rising steps with the same leading source merged into one episode');
  assert.equal(up.to, at(22 * H));
  assert.deepEqual(r.gaps.map((g) => g.hours), [4]);
  assert.match(r.headline[0], /^Over 25 h the raw reading went \d+ → \d+ \(.\d+\); TikTok hashtag explains/);
  assert.equal(r.note, null);
  assert.equal(explainMoves([], { windowStartMs: T0 - 25 * H, category: 'memes', now: T0 }).note, 'No hourly snapshots in this window.');
  assert.equal(explainMoves([snap(1, comps(1))], { windowStartMs: T0 - 25 * H, category: 'memes', now: T0 }).moves.length, 0);
  const quiet = explainMoves([snap(2, comps(10_000)), snap(1, comps(10_050))], { windowStartMs: T0 - 25 * H, category: 'memes', now: T0 });
  assert.match(quiet.note ?? '', /^Quiet window/);
});

test('spendToday matches the vi-run-report arithmetic', () => {
  const rows = [
    { source: 'x', meta: { tweets: 400, requests: 2 } },
    { source: 'x_account', meta: { tweets: 10, requests: 1 } },
    { source: 'tiktok', meta: { queried: 50 } },
    { source: 'tiktok_search', meta: { searched: 2, results: 20, reads: 30 } },
    { source: 'post', meta: { reads: 3, platform: 'instagram' } },
    { source: 'youtube', meta: { searched: 7 } },
  ];
  const s = Object.fromEntries(spendToday(rows, PRICES).map((r) => [r.source, r]));
  assert.ok(Math.abs(s.x.usd - (400 * 0.00015 + 10 * 0.00015)) < 1e-12);
  assert.equal(s.tiktok.usd, 50 * 0.0005);
  assert.ok(Math.abs(s.tiktok_search.usd - (20 * 0.004 + 30 * 0.0003)) < 1e-12);
  assert.ok(Math.abs(s.post.usd - 3 * 0.0027) < 1e-12);
  assert.equal(s.youtube.units[0].n, 7);
});

test('cronHealth: a full hour, a missing hour, the hour in progress', () => {
  const now = Date.parse('2026-10-05T12:20:00Z');
  const h = (iso: string) => Date.parse(iso);
  const full = Array.from({ length: 12 }, (_, i) => [h('2026-10-05T10:00:00Z') + i * 5 * MIN, 100] as [number, number]);
  const partial = Array.from({ length: 4 }, (_, i) => [h('2026-10-05T12:00:00Z') + i * 5 * MIN, 100] as [number, number]);
  const fast = new Map([['m1', [...full, ...partial]], ['m2', [...full, ...partial]]]);
  const snapshots = [
    { market_id: 'm1', recorded_at: '2026-10-05T10:07:00Z' }, { market_id: 'm2', recorded_at: '2026-10-05T10:07:00Z' },
    { market_id: 'm1', recorded_at: '2026-10-05T12:07:00Z' }, { market_id: 'm2', recorded_at: '2026-10-05T12:07:00Z' },
  ];
  const r = cronHealth({ fastSeries: fast, snapshots, liveCount: 2, now });
  const byHour = Object.fromEntries(r.hours.map((x) => [x.hour, x]));
  assert.equal(byHour['2026-10-05T10:00:00.000Z'].ok, true);
  assert.equal(byHour['2026-10-05T11:00:00.000Z'].ok, false);
  assert.equal(byHour['2026-10-05T12:00:00.000Z'].ok, true, 'the hour in progress is judged pro rata');
  assert.equal(r.fastLastAt, new Date(h('2026-10-05T12:15:00Z')).toISOString());
  assert.match(r.sentences[0], /^Fast refresh last wrote 5 min ago; 4 of 4 five-minute slots/);
});
