// The Virality Index in plain words. Pure functions over a market's stored
// breakdown (markets.vi_components), its hourly snapshots
// (vi_component_history) and the day's samples (vi_samples), for the
// admin's VI tab (app/admin/vi-tab.tsx through lib/vi/diagnostics.ts).
// Nothing here reads the database or the environment: prices and the
// calibration come in as arguments, and every function takes `now`, so
// the tests pin the clock. Runs on the server only: CALIBRATION reads
// VI_CALIBRATION_JSON and lib/signals.ts pulls the adapters.
import {
  attention,
  combine,
  isGenericTerm,
  momentumScore,
  sourceReading,
  viTier,
  CALIBRATION,
  LEVEL_SHARE,
  MOMENTUM_SHARE,
  metaNumber,
  median,
  type Calibration,
  type Components,
  type SourceComponent,
  type SourceName,
} from './score';
import { normalizeSearchTerm } from './trends';
import { scoringComponents, sourceApplies } from '../signals';
import { FLAG_TEXT, SOURCE_LABEL, SOURCE_ORDER, SOURCE_UNIT, type Freshness, type ViFlag } from './labels';

const MIN = 60_000;
const HOUR = 3600_000;
const DAY = 24 * HOUR;

// --- Formatting ------------------------------------------------------------------

export function fmtCount(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e6) return `${(n / 1e6).toFixed(a >= 1e7 ? 0 : 1)}M`;
  if (a >= 1e4) return `${Math.round(n / 1e3)}k`;
  if (a >= 1e3) return `${(n / 1e3).toFixed(1)}k`;
  if (a >= 100 || Number.isInteger(n)) return Math.round(n).toLocaleString('en-US');
  if (a >= 1) return n.toFixed(1);
  return n.toPrecision(2);
}
export const fmtRatio = (r: number): string => `${r >= 10 ? r.toFixed(0) : r.toFixed(1)}×`;
export function fmtPct(share: number): string {
  if (share <= 0) return '0%';
  if (share < 0.005) return '<1%';
  return `${Math.round(share * 100)}%`;
}
export function fmtAge(ms: number): string {
  if (ms < MIN) return 'under a minute';
  if (ms < HOUR) return `${Math.round(ms / MIN)} min`;
  if (ms < 2 * DAY) return `${Math.round(ms / HOUR)} h`;
  return `${Math.round(ms / DAY)} d`;
}
export function fmtUsd(n: number): string {
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  return `$${n.toFixed(2)}`;
}
const fmtMom = (m: number | null): string => (m === null ? 'no baseline yet' : `${fmtRatio(m)} its baseline`);

// --- Freshness --------------------------------------------------------------------

export const SOURCE_CADENCE: Record<SourceName, { everyMs: number; text: string }> = {
  trends: { everyMs: 5 * MIN, text: 'every 5 min' },
  bluesky: { everyMs: 5 * MIN, text: 'every 5 min' },
  dex: { everyMs: 5 * MIN, text: 'every 5 min' },
  wikipedia: { everyMs: HOUR, text: 'hourly' },
  gdelt: { everyMs: HOUR, text: 'hourly (daily data)' },
  youtube: { everyMs: HOUR, text: 'hourly; a new search every 1 to 3 days' },
  hn: { everyMs: HOUR, text: 'hourly' },
  x: { everyMs: 3 * HOUR, text: 'every 3 h' },
  tiktok: { everyMs: 3 * HOUR, text: 'every 3 h' },
  tiktok_search: { everyMs: 6 * HOUR, text: 'every 6 h; a new search every 1 to 3 days' },
  post: { everyMs: 3 * HOUR, text: 'hourly on the first day, then every 3 h' },
};
const SLOW_RUN_SLACK = 20 * MIN;
const EXPIRING_AFTER = 40 * HOUR;

export function cadenceMs(source: SourceName, c: SourceComponent | null | undefined, now: number): number {
  if (source === 'post') {
    const first = typeof c?.meta?.first_read_at === 'string' ? Date.parse(c.meta.first_read_at) : NaN;
    if (Number.isFinite(first) && now - first < DAY) return HOUR;
  }
  return SOURCE_CADENCE[source].everyMs;
}

export function freshness(source: SourceName, c: SourceComponent, now: number): { ageMs: number; everyMs: number; state: Freshness } {
  const everyMs = cadenceMs(source, c, now);
  const at = Date.parse(c.fetchedAt);
  const ageMs = Number.isFinite(at) ? Math.max(0, now - at) : Infinity;
  let state: Freshness;
  if (c.level === null) state = 'unknown';
  else if (ageMs > EXPIRING_AFTER) state = 'expiring';
  else if (ageMs <= everyMs + SLOW_RUN_SLACK) state = 'fresh';
  else if (ageMs <= 2 * everyMs + HOUR) state = 'late';
  else state = 'stale';
  return { ageMs, everyMs, state };
}

// --- Cost --------------------------------------------------------------------------

export interface Prices {
  usdPerTweet: number;
  usdPerRequestMin: number;
  usdPerHashtag: number;
  usdPerSearchResult: number;
  resultsPerSearch: number;
  usdPerPostRead: Record<'tiktok' | 'instagram' | 'x', number>;
}

export function lastReadCost(c: SourceComponent, prices: Prices): { usd: number | null; perDayUsd: number | null; facts: string } {
  const m = c.meta ?? {};
  const n = (k: string) => metaNumber(m[k]) ?? 0;
  let usd: number | null = 0;
  let facts = 'free API';
  switch (c.source) {
    case 'x': {
      usd = Math.max(n('tweets') * prices.usdPerTweet, n('requests') * prices.usdPerRequestMin);
      facts = `${fmtCount(n('tweets'))} posts read in ${fmtCount(n('requests'))} request${n('requests') === 1 ? '' : 's'}${m.capped ? ', capped' : ''}`;
      break;
    }
    case 'tiktok':
      usd = n('queried') * prices.usdPerHashtag;
      facts = `${fmtCount(n('queried'))} hashtag${n('queried') === 1 ? '' : 's'} queried`;
      break;
    case 'tiktok_search': {
      const search = prices.resultsPerSearch * prices.usdPerSearchResult;
      const reread = n('posts_read') * prices.usdPerPostRead.tiktok;
      usd = reread + (m.searched_at ? search : 0);
      facts = `a search ≈ ${fmtUsd(search)}, a re-read of ${fmtCount(n('posts_read'))} posts ≈ ${fmtUsd(reread)}`;
      break;
    }
    case 'post':
      usd = n('posts_read') * prices.usdPerPostRead.tiktok;
      facts = `${fmtCount(n('posts_read'))} post${n('posts_read') === 1 ? '' : 's'} re-read (≈ at the TikTok price)`;
      break;
    case 'youtube':
      usd = 0;
      facts = 'free; the daily search quota is the limit';
      break;
    default:
      usd = 0;
  }
  const everyMs = cadenceMs(c.source, c, Date.now());
  return { usd, perDayUsd: usd === null ? null : (usd * DAY) / everyMs, facts };
}

// --- One source ----------------------------------------------------------------------

export interface SourceExplanation {
  source: SourceName;
  label: string;
  status: 'seeing' | 'zero' | 'unknown';
  reading: number | null;
  unit: string;
  readingText: string;
  level: number | null;
  momentum: number | null;
  momentumText: string;
  share: number | null;
  term: number | null;
  ageMs: number;
  everyMs: number;
  freshness: Freshness;
  costUsd: number | null;
  perDayUsd: number | null;
  costFacts: string;
  sentence: string;
  meta: [string, string][];
}

const str = (v: unknown): string | null => (typeof v === 'string' && v ? v : null);

// What the reading is, in the source's own words. Pure.
export function readingText(c: SourceComponent, reading: number | null, now: number): string {
  const m = c.meta ?? {};
  const n = (k: string) => metaNumber(m[k]);
  switch (c.source) {
    case 'trends': {
      if (m.below_resolution) return `searched below Google Trends' resolution against '${str(m.benchmark) ?? 'the benchmark'}', counted as unknown`;
      const kw = str(m.topic) ?? str(m.keyword);
      return `searched at ${reading === null ? '?' : fmtCount(reading)}× the benchmark query '${str(m.benchmark) ?? '?'}'${kw ? ` (as '${kw}')` : ''}`;
    }
    case 'bluesky': {
      const raw = m.posts_24h;
      const capped = typeof raw === 'string' && raw.endsWith('+');
      const day = capped ? `${fmtCount(Number(raw.slice(0, -1)))}+ (capped)` : reading === null ? '?' : fmtCount(reading);
      return `${day} posts in 24 h (${fmtCount(n('posts_1h') ?? 0)} in the last hour)`;
    }
    case 'gdelt':
      return `${reading === null ? '?' : fmtCount(reading)}% of the week's news articles (latest day ${fmtCount(n('articles_pct_latest') ?? 0)}%)`;
    case 'wikipedia': {
      const title = str(m.title);
      const latest = n('views_latest');
      return `${title ? `'${title}' gets ` : ''}${reading === null ? '?' : fmtCount(reading)} views a day (14-day median${latest !== null ? `; ${fmtCount(latest)} on ${str(m.latest_date) ?? 'the latest day'}` : ''})`;
    }
    case 'youtube': {
      const search = n('views_7d') ?? 0;
      const videos = n('video_count') ?? 0;
      const top = n('top_views');
      let s = `${fmtCount(search)} views this week across ${fmtCount(videos)} videos${top !== null ? ` (top ${fmtCount(top)})` : ''}`;
      const ch = n('channel_views_7d');
      if (ch !== null) {
        const shorts = n('channel_shorts_share');
        s += `; own channel ${fmtCount(ch)} a week${shorts !== null ? `, ${fmtPct(shorts)} Shorts` : ''}, ${reading !== null && reading > search ? 'which scores' : 'the search scores'}`;
      }
      return s;
    }
    case 'hn':
      return `${fmtCount(reading ?? 0)} hits in 24 h, ${fmtCount(n('hits_7d') ?? 0)} this week`;
    case 'dex':
      return `${fmtUsd(n('volume_24h_usd') ?? 0)} traded in 24 h${str(m.chain) ? ` on ${str(m.chain)}` : ''}${str(m.symbol) ? ` (${str(m.symbol)})` : ''}; not scored (uncalibrated)`;
    case 'x': {
      let s = `${reading === null ? '?' : fmtCount(reading)} impressions a day on posts about the name`;
      const own = n('own_views_per_h');
      if (own !== null) s += `; own account ${fmtCount(own * 24)} a day, counted at ${fmtPct(0.694)}`;
      return s;
    }
    case 'tiktok':
      return `${reading === null ? '?' : fmtCount(reading)} views a day under #${str(m.hashtag) ?? '?'}`;
    case 'tiktok_search': {
      const at = typeof m.searched_at === 'string' ? Date.parse(m.searched_at) : NaN;
      return `${reading === null ? '?' : fmtCount(reading)} views a day across ${fmtCount(n('posts_read') ?? 0)} of the past week's posts for '${str(m.query) ?? '?'}'${Number.isFinite(at) ? `, searched ${fmtAge(now - at)} ago` : ''}`;
    }
    case 'post':
      return `${reading === null ? '?' : fmtCount(reading)} views a day across ${fmtCount(n('posts_read') ?? 0)} captured post${n('posts_read') === 1 ? '' : 's'}`;
  }
}

export interface SourceContext {
  shares: Partial<Record<SourceName, number>>;
  terms: Partial<Record<SourceName, number>>;
  now: number;
  prices: Prices;
  cal?: Calibration;
}

export function explainSource(c: SourceComponent, ctx: SourceContext): SourceExplanation {
  const cal = ctx.cal ?? CALIBRATION;
  const label = SOURCE_LABEL[c.source];
  const reading = sourceReading(c, cal);
  const term = ctx.terms[c.source] ?? null;
  const share = ctx.shares[c.source] ?? null;
  const f = freshness(c.source, c, ctx.now);
  const cost = lastReadCost(c, ctx.prices);
  const status: SourceExplanation['status'] = c.level === null ? 'unknown' : (term ?? 0) > 0 ? 'seeing' : 'zero';
  const meta = Object.entries(c.meta ?? {})
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]): [string, string] => [k, v === null ? '—' : String(v).length > 160 ? `${String(v).slice(0, 157)}…` : String(v)]);
  let sentence: string;
  if (status === 'unknown') {
    sentence = `${label}: did not answer on the last read (${fmtAge(f.ageMs)} ago); not counted.`;
  } else {
    const tail = [
      fmtMom(c.momentum),
      share === null ? null : `${fmtPct(share)} of this market's attention`,
      `read ${fmtAge(f.ageMs)} ago (due ${SOURCE_CADENCE[c.source].text})`,
      cost.usd === null || cost.usd === 0 ? null : `last read ≈ ${fmtUsd(cost.usd)}, ≈ ${fmtUsd(cost.perDayUsd ?? 0)} a day`,
    ].filter((x): x is string => x !== null);
    sentence = `${label}: ${readingText(c, reading, ctx.now)} · ${tail.join(' · ')}.`;
  }
  return {
    source: c.source,
    label,
    status,
    reading,
    unit: SOURCE_UNIT[c.source],
    readingText: status === 'unknown' ? 'no reading' : readingText(c, reading, ctx.now),
    level: c.level,
    momentum: c.momentum,
    momentumText: c.momentum === null ? '—' : fmtRatio(c.momentum),
    share,
    term,
    ageMs: f.ageMs,
    everyMs: f.everyMs,
    freshness: f.state,
    costUsd: cost.usd,
    perDayUsd: cost.perDayUsd,
    costFacts: cost.facts,
    sentence,
    meta,
  };
}

// --- The composite ----------------------------------------------------------------

export interface ViMarketInput {
  id: string;
  name: string;
  entityType: string | null;
  category: string | null;
  currentVi: number | null;
  viState: string | null;
  viLastUpdated: string | null;
  createdAt?: string | null;
  aliases: string[];
  components: Components | null;
}

interface Scored {
  scored: Components;
  notes: string[];
  A: number;
  terms: Partial<Record<SourceName, number>>;
  shares: Partial<Record<SourceName, number>>;
  seeing: SourceComponent[];
  // Each source's pull on the momentum axis, g_s = w_s · (momentumScore(m_s) − 500).
  g: Partial<Record<SourceName, number>>;
  M: number;
  L: number;
  F: number;
  S: number;
}

function scoreUnrounded(components: Components, category: string | null, cal: Calibration): Scored {
  const { components: scored, notes } = scoringComponents(components, { category, creator: true });
  const at = attention(scored, cal);
  const seeing = (Object.values(scored) as (SourceComponent | undefined)[]).filter((c): c is SourceComponent => !!c && (at.terms[c.source] ?? 0) > 0);
  const withMom = seeing.filter((c) => c.momentum !== null);
  const sumShare = withMom.reduce((s, c) => s + (at.shares[c.source] ?? 0), 0);
  const g: Partial<Record<SourceName, number>> = {};
  let M = 500;
  for (const c of withMom) {
    const w = sumShare > 0 ? (at.shares[c.source] ?? 0) / sumShare : 0;
    g[c.source] = w * (momentumScore(c.momentum as number) - 500);
    M += g[c.source]!;
  }
  const L = at.A > 0 ? cal.pointsPerDecade * Math.log10(1 + at.A / 10 ** cal.log10ZeroPoint) : 0;
  const F = LEVEL_SHARE + MOMENTUM_SHARE * (M / 500);
  return { scored, notes, A: at.A, terms: at.terms, shares: at.shares, seeing, g, M, L, F, S: L * F };
}

export interface CompositeExplanation {
  score: number | null;
  level: number;
  attention: number;
  momentumAxis: number;
  momentumRatio: number | null;
  factor: number;
  publishedVi: number | null;
  latestRaw: number | null;
  reconstructionGap: number | null;
  sentences: string[];
}

export function explainComposite(
  stored: Components,
  { category, currentVi, viState, latestRaw, cal = CALIBRATION }: { category: string | null; currentVi: number | null; viState: string | null; latestRaw: number | null; cal?: Calibration }
): CompositeExplanation {
  const s = scoreUnrounded(stored, category, cal);
  const composite = combine(s.scored, { calibration: cal });
  const score = composite?.score ?? null;
  const hasMom = s.seeing.some((c) => c.momentum !== null);
  const ratio = hasMom ? 10 ** ((s.M - 500) / 500) : null;
  const sentences: string[] = [];
  if (!composite) sentences.push('No source has answered yet, so there is nothing to score.');
  else if (s.seeing.length === 0) sentences.push(`${s.scored && Object.keys(s.scored).length} sources answered and every one sees nothing: the level is 0.`);
  else {
    sentences.push(`Level ${composite.level} from ${fmtCount(s.A)} YouTube-view-equivalents a week across ${s.seeing.length} source${s.seeing.length === 1 ? '' : 's'}.`);
    if (ratio === null) sentences.push('No source has a baseline yet, so momentum is neutral (×1.00) and the score is the level.');
    else sentences.push(`Weighted by share, the sources run at ${fmtRatio(ratio)} their own baselines, which multiplies the level by ${s.F.toFixed(2)} → ${score}.`);
  }
  const gap = score !== null && currentVi !== null ? score - currentVi : null;
  if (gap !== null && Math.abs(gap) >= 1) {
    sentences.push(`Published VI ${Math.round(currentVi as number)} ${gap > 0 ? 'trails' : 'is above'} the reading by ${Math.abs(Math.round(gap))}; with the 2-hour half-life, half of that shows within 2 h if readings hold.`);
  }
  if (score !== null && latestRaw !== null && Math.abs(score - latestRaw) >= 1) {
    sentences.push(`Recomputed from the stored breakdown: ${score}; last raw written ${Math.round(latestRaw)} (a fresher fast reading, the creator ramp or a calibration change in between).`);
  }
  if (viState === 'scoring') sentences.push('Still scoring: the first full pass has not finished; the market goes live within two hours of its creation.');
  sentences.push(...s.notes);
  return {
    score,
    level: composite?.level ?? 0,
    attention: s.A,
    momentumAxis: Math.round(s.M),
    momentumRatio: ratio,
    factor: s.F,
    publishedVi: currentVi,
    latestRaw,
    reconstructionGap: gap,
    sentences,
  };
}

export interface MarketExplanation {
  composite: CompositeExplanation;
  sources: SourceExplanation[];
  notAsked: { source: SourceName; label: string; why: string }[];
  flags: ViFlag[];
  flagText: { flag: ViFlag; short: string; long: string }[];
}

export function explainMarket(m: ViMarketInput, { now, prices, latestRaw = null, cal = CALIBRATION }: { now: number; prices: Prices; latestRaw?: number | null; cal?: Calibration }): MarketExplanation {
  const components = m.components ?? {};
  const s = scoreUnrounded(components, m.category, cal);
  const composite = explainComposite(components, { category: m.category, currentVi: m.currentVi, viState: m.viState, latestRaw, cal });
  const ctx: SourceContext = { shares: s.shares, terms: s.terms, now, prices, cal };
  const sources = (Object.values(s.scored) as (SourceComponent | undefined)[])
    .filter((c): c is SourceComponent => !!c)
    .map((c) => explainSource(c, ctx))
    .sort((a, b) => (a.status === 'unknown' ? 1 : 0) - (b.status === 'unknown' ? 1 : 0) || (b.share ?? 0) - (a.share ?? 0) || SOURCE_ORDER.indexOf(a.source) - SOURCE_ORDER.indexOf(b.source));
  const generic = isGenericTerm(normalizeSearchTerm({ name: m.name }), components.wikipedia?.meta, { entityType: m.entityType });
  const notAsked: MarketExplanation['notAsked'] = [];
  for (const source of SOURCE_ORDER) {
    if (components[source]) continue;
    let why: string;
    if (!sourceApplies(source, { category: m.category, entityType: m.entityType })) why = 'not this category';
    else if (generic && (source === 'trends' || source === 'bluesky')) why = 'dropped by the generic-term guard';
    else why = 'no reading in 48 h, or not configured';
    notAsked.push({ source, label: SOURCE_LABEL[source], why });
  }
  const flags = marketFlags(m, s, sources, composite, generic);
  return { composite, sources, notAsked, flags, flagText: flags.map((flag) => ({ flag, ...FLAG_TEXT[flag] })) };
}

function marketFlags(m: ViMarketInput, s: Scored, sources: SourceExplanation[], composite: CompositeExplanation, generic: boolean): ViFlag[] {
  const flags: ViFlag[] = [];
  if ((m.currentVi ?? 0) < 0.5 || composite.score === 0) flags.push('zero');
  if (m.viState === 'scoring') flags.push('scoring');
  const top = Math.max(0, ...Object.values(s.shares).map((v) => v ?? 0));
  if (s.seeing.length > 0 && top > 0.8) flags.push('dominant');
  if (generic) flags.push('generic');
  if (s.seeing.length > 0 && !s.seeing.some((c) => c.momentum !== null)) flags.push('no_momentum');
  if (sources.some((x) => x.freshness === 'stale' || x.freshness === 'expiring')) flags.push('stale');
  if (composite.reconstructionGap !== null && Math.abs(composite.reconstructionGap) >= 25) flags.push('catching_up');
  return flags;
}

// --- The market list ----------------------------------------------------------------

export interface ViMarketRow {
  id: string;
  name: string;
  category: string | null;
  vi: number;
  tier: string;
  d24: number | null;
  topSource: SourceName | null;
  topLabel: string | null;
  topShare: number | null;
  answering: number;
  asked: number;
  seeing: number;
  staleSources: SourceName[];
  flags: ViFlag[];
  updatedAt: string | null;
  reconstructed: number | null;
}

export function diagnoseMarket(m: ViMarketInput, { now, prices, d24 = null, cal = CALIBRATION }: { now: number; prices: Prices; d24?: number | null; cal?: Calibration }): ViMarketRow {
  const e = explainMarket(m, { now, prices, cal });
  const top = e.sources.find((x) => x.status === 'seeing');
  const topShare = top?.share ?? null;
  const topSource = topShare !== null && topShare > 0 ? top!.source : null;
  return {
    id: m.id,
    name: m.name,
    category: m.category,
    vi: Math.round(m.currentVi ?? 0),
    tier: viTier(m.currentVi ?? 0).label,
    d24,
    topSource,
    topLabel: topSource ? SOURCE_LABEL[topSource] : null,
    topShare,
    answering: e.sources.filter((x) => x.status !== 'unknown').length,
    asked: e.sources.length,
    seeing: e.sources.filter((x) => x.status === 'seeing').length,
    staleSources: e.sources.filter((x) => x.freshness === 'stale' || x.freshness === 'expiring').map((x) => x.source),
    flags: e.flags,
    updatedAt: m.viLastUpdated,
    reconstructed: e.composite.score,
  };
}

// --- Coverage across markets --------------------------------------------------------

export interface SourceCoverage {
  source: SourceName;
  label: string;
  cadenceText: string;
  answering: number;
  seeing: number;
  unknown: number;
  notAsked: number;
  stale: number;
  late: number;
  medianAgeMs: number | null;
  oldestAgeMs: number | null;
}

export function coverage(markets: ViMarketInput[], now: number, cal: Calibration = CALIBRATION): SourceCoverage[] {
  return SOURCE_ORDER.map((source) => {
    let answering = 0, seeing = 0, unknown = 0, notAsked = 0, stale = 0, late = 0;
    const ages: number[] = [];
    for (const m of markets) {
      const c = m.components?.[source];
      if (!c) {
        notAsked++;
        continue;
      }
      const term = attention(scoringComponents(m.components ?? {}, { category: m.category, creator: true }).components, cal).terms[source] ?? 0;
      if (c.level === null) unknown++;
      else {
        answering++;
        if (term > 0) seeing++;
      }
      const f = freshness(source, c, now);
      if (Number.isFinite(f.ageMs)) ages.push(f.ageMs);
      if (f.state === 'stale' || f.state === 'expiring') stale++;
      else if (f.state === 'late') late++;
    }
    return {
      source,
      label: SOURCE_LABEL[source],
      cadenceText: SOURCE_CADENCE[source].text,
      answering,
      seeing,
      unknown,
      notAsked,
      stale,
      late,
      medianAgeMs: ages.length ? median(ages) : null,
      oldestAgeMs: ages.length ? Math.max(...ages) : null,
    };
  });
}

// --- Moves, hour to hour ------------------------------------------------------------

export interface Snapshot {
  at: string;
  components: Components;
  raw: number | null;
  vi: number | null;
  attention: number | null;
}

export interface SourceDelta {
  source: SourceName;
  label: string;
  change: 'new' | 'dropped' | 'changed' | 'reread_same' | 'not_reread';
  readingBefore: number | null;
  readingAfter: number | null;
  shareBefore: number;
  shareAfter: number;
  momentumBefore: number | null;
  momentumAfter: number | null;
  levelPts: number;
  momentumPts: number;
  pts: number;
}

export interface Move {
  from: string;
  to: string;
  rawBefore: number | null;
  rawAfter: number | null;
  viBefore: number | null;
  viAfter: number | null;
  dRaw: number | null;
  dScore: number;
  dVi: number | null;
  contributions: SourceDelta[];
  residual: number | null;
  olderCalibration: boolean;
  sentence: string;
}

function pretty(source: SourceName, r: number | null): string {
  if (r === null) return '—';
  if (source === 'trends') return `${fmtCount(r)}×`;
  if (source === 'gdelt') return `${fmtCount(r)}%`;
  return fmtCount(r);
}

export function attributeStep(a: Snapshot, b: Snapshot, { category, cal = CALIBRATION }: { category: string | null; cal?: Calibration }): Move {
  const A = scoreUnrounded(a.components, category, cal);
  const B = scoreUnrounded(b.components, category, cal);
  const dL = B.L - A.L;
  const dA = B.A - A.A;
  const Fm = (A.F + B.F) / 2;
  const Lm = (A.L + B.L) / 2;
  const slope = dA !== 0 ? dL / dA : cal.pointsPerDecade / (Math.LN10 * (10 ** cal.log10ZeroPoint + A.A));
  const names = new Set<SourceName>([...(Object.keys(a.components) as SourceName[]), ...(Object.keys(b.components) as SourceName[])]);
  const contributions: SourceDelta[] = [];
  for (const source of names) {
    const ca = A.scored[source];
    const cb = B.scored[source];
    const ta = A.terms[source] ?? 0;
    const tb = B.terms[source] ?? 0;
    const ra = ca ? sourceReading(ca, cal) : null;
    const rb = cb ? sourceReading(cb, cal) : null;
    const levelPts = Fm * (tb - ta) * slope;
    const momentumPts = Lm * (MOMENTUM_SHARE / 500) * ((B.g[source] ?? 0) - (A.g[source] ?? 0));
    let change: SourceDelta['change'];
    if (ta === 0 && tb > 0 && ra === null) change = 'new';
    else if (!ca && cb) change = 'new';
    else if (ca && !cb) change = 'dropped';
    else if (ra !== null && rb !== null && (ra === 0 ? rb !== 0 : Math.abs(rb - ra) / Math.abs(ra) >= 0.01)) change = 'changed';
    else if (ra === null && rb !== null) change = 'new';
    else if (ra !== null && rb === null) change = 'dropped';
    else if (ca && cb && ca.fetchedAt !== cb.fetchedAt) change = 'reread_same';
    else change = 'not_reread';
    contributions.push({
      source,
      label: SOURCE_LABEL[source],
      change,
      readingBefore: ra,
      readingAfter: rb,
      shareBefore: A.shares[source] ?? 0,
      shareAfter: B.shares[source] ?? 0,
      momentumBefore: ca?.momentum ?? null,
      momentumAfter: cb?.momentum ?? null,
      levelPts,
      momentumPts,
      pts: levelPts + momentumPts,
    });
  }
  contributions.sort((x, y) => Math.abs(y.pts) - Math.abs(x.pts));
  const dScore = B.S - A.S;
  const dRaw = a.raw !== null && b.raw !== null ? b.raw - a.raw : null;
  const dVi = a.vi !== null && b.vi !== null ? b.vi - a.vi : null;
  const residual = dRaw === null ? null : dRaw - dScore;
  const olderCalibration = [a, b].some((s) => s.attention !== null && s.attention > 0 && Math.abs(s.attention - scoreUnrounded(s.components, category, cal).A) / s.attention > 0.02);
  return { from: a.at, to: b.at, rawBefore: a.raw, rawAfter: b.raw, viBefore: a.vi, viAfter: b.vi, dRaw, dScore, dVi, contributions, residual, olderCalibration, sentence: moveSentence({ dRaw, dScore, dVi, rawBefore: a.raw, rawAfter: b.raw, contributions, residual, olderCalibration }) };
}

const signed = (n: number): string => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(Math.round(n))}`;

function moveSentence(m: Pick<Move, 'dRaw' | 'dScore' | 'dVi' | 'rawBefore' | 'rawAfter' | 'contributions' | 'residual' | 'olderCalibration'>): string {
  const d = m.dRaw ?? m.dScore;
  const head = m.dRaw !== null && m.rawBefore !== null && m.rawAfter !== null
    ? `Raw ${signed(m.dRaw)} (${Math.round(m.rawBefore)} → ${Math.round(m.rawAfter)})${m.dVi !== null ? `, published VI ${signed(m.dVi)} (2-hour smoothing)` : ''}`
    : `Recomputed score ${signed(m.dScore)}`;
  const moved = m.contributions.filter((c) => Math.abs(c.pts) >= 0.5);
  const shown = moved.filter((c, i) => i < 3 || Math.abs(c.pts) >= 0.1 * Math.abs(d));
  const rest = moved.filter((c) => !shown.includes(c));
  const parts = shown.map((c) => {
    const what =
      c.change === 'new' ? `appears at ${pretty(c.source, c.readingAfter)}`
      : c.change === 'dropped' ? `dropped (was ${pretty(c.source, c.readingBefore)})`
      : c.change === 'changed' ? `${pretty(c.source, c.readingBefore)} → ${pretty(c.source, c.readingAfter)} (share ${fmtPct(c.shareBefore)} → ${fmtPct(c.shareAfter)})`
      : c.momentumBefore !== c.momentumAfter ? `momentum ${c.momentumBefore === null ? '—' : fmtRatio(c.momentumBefore)} → ${c.momentumAfter === null ? '—' : fmtRatio(c.momentumAfter)}`
      : `share ${fmtPct(c.shareBefore)} → ${fmtPct(c.shareAfter)}`;
    return `${c.label} ${what} ${signed(c.pts)}`;
  });
  const restPts = rest.reduce((s, c) => s + c.pts, 0);
  if (rest.length) parts.push(`others ${signed(restPts)}`);
  const notReread = m.contributions.filter((c) => c.change === 'not_reread' && Math.abs(c.pts) < 0.5).map((c) => c.label);
  const unchanged = m.contributions.filter((c) => c.change === 'reread_same' && Math.abs(c.pts) < 0.5).map((c) => c.label);
  let s = parts.length ? `${head}: ${parts.join('; ')}.` : `${head}: no reading changed.`;
  if (m.residual !== null && Math.abs(m.residual) >= 3) s += ` ${Math.abs(Math.round(m.residual))} points not explained by readings (a calibration change, a fresher fast reading merged in, or the creator ramp).`;
  if (m.olderCalibration) s += ' A snapshot was written under an older calibration.';
  if (notReread.length) s += ` Not re-read: ${notReread.join(', ')}.`;
  if (unchanged.length) s += ` Unchanged: ${unchanged.join(', ')}.`;
  return s;
}

export interface MovesExplanation {
  headline: string[];
  moves: Move[];
  gaps: { from: string; to: string; hours: number }[];
  note: string | null;
  largestStep: number | null;
}

export function explainMoves(
  snaps: Snapshot[],
  { windowStartMs, minPoints = 10, maxMoves = 8, category, now, cal = CALIBRATION }: { windowStartMs: number; minPoints?: number; maxMoves?: number; category: string | null; now: number; cal?: Calibration }
): MovesExplanation {
  const sorted = [...snaps].filter((s) => Number.isFinite(Date.parse(s.at))).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const before = sorted.filter((s) => Date.parse(s.at) < windowStartMs);
  const inWindow = sorted.filter((s) => Date.parse(s.at) >= windowStartMs);
  const used = before.length ? [before[before.length - 1], ...inWindow] : inWindow;
  if (used.length < 2) {
    return { headline: [], moves: [], gaps: [], largestStep: null, note: used.length === 0 ? 'No hourly snapshots in this window.' : 'Only one snapshot in this window; nothing to compare yet.' };
  }
  const steps: Move[] = [];
  const gaps: MovesExplanation['gaps'] = [];
  for (let i = 1; i < used.length; i++) {
    const hours = (Date.parse(used[i].at) - Date.parse(used[i - 1].at)) / HOUR;
    if (hours > 2.5) gaps.push({ from: used[i - 1].at, to: used[i].at, hours: Math.round(hours * 10) / 10 });
    steps.push(attributeStep(used[i - 1], used[i], { category, cal }));
  }
  const size = (m: Move) => Math.abs(m.dRaw ?? m.dScore);
  const largestStep = steps.length ? Math.max(...steps.map(size)) : null;
  const kept = steps.filter((m) => size(m) >= minPoints);
  // Consecutive steps the same way with the same leading source are one episode.
  const episodes: Move[] = [];
  const top = (m: Move) => m.contributions[0]?.source ?? null;
  const sign = (m: Move) => Math.sign(m.dRaw ?? m.dScore);
  for (const m of kept) {
    const last = episodes[episodes.length - 1];
    if (last && last.to === m.from && sign(last) === sign(m) && top(last) === top(m)) {
      episodes[episodes.length - 1] = attributeStep(
        { at: last.from, components: used.find((s) => s.at === last.from)!.components, raw: last.rawBefore, vi: last.viBefore, attention: null },
        { at: m.to, components: used.find((s) => s.at === m.to)!.components, raw: m.rawAfter, vi: m.viAfter, attention: null },
        { category, cal }
      );
    } else episodes.push(m);
  }
  const moves = episodes.sort((x, y) => size(y) - size(x)).slice(0, maxMoves).sort((x, y) => Date.parse(y.to) - Date.parse(x.to));
  const whole = attributeStep(used[0], used[used.length - 1], { category, cal });
  const span = fmtAge(now - Math.max(windowStartMs, Date.parse(used[0].at)));
  const lead = whole.contributions.filter((c) => Math.abs(c.pts) >= 0.5).slice(0, 3);
  const rest = whole.contributions.filter((c) => Math.abs(c.pts) >= 0.5).slice(3).reduce((s, c) => s + c.pts, 0);
  const headline: string[] = [];
  if (whole.rawBefore !== null && whole.rawAfter !== null) {
    headline.push(`Over ${span} the raw reading went ${Math.round(whole.rawBefore)} → ${Math.round(whole.rawAfter)} (${signed(whole.rawAfter - whole.rawBefore)})${lead.length ? `; ${lead.map((c) => `${c.label} explains ${signed(c.pts)}`).join(', ')}${Math.abs(rest) >= 0.5 ? `, others ${signed(rest)}` : ''}` : ''}.`);
  } else headline.push(`Over ${span} the recomputed score moved ${signed(whole.dScore)}.`);
  const last = used[used.length - 1];
  if (last.raw !== null && last.vi !== null && Math.abs(last.raw - last.vi) >= 1) headline.push(`At the last snapshot the published VI (${Math.round(last.vi)}) still had ${signed(last.raw - last.vi)} to close toward the raw reading.`);
  const note = kept.length === 0 ? `Quiet window: the largest hourly move was ${signed(largestStep ?? 0)}.` : null;
  return { headline, moves, gaps, note, largestStep };
}

// --- Spend and cron health ----------------------------------------------------------

export interface SpendRow {
  source: string;
  label: string;
  usd: number;
  units: { label: string; n: number }[];
}

export function spendToday(rows: { source: string; meta: Record<string, unknown> | null }[], prices: Prices): SpendRow[] {
  const n = (r: { meta: Record<string, unknown> | null }, k: string) => metaNumber(r.meta?.[k]) ?? 0;
  const x = rows.filter((r) => r.source === 'x' || r.source === 'x_account');
  const tiktok = rows.filter((r) => r.source === 'tiktok');
  const search = rows.filter((r) => r.source === 'tiktok_search');
  const post = rows.filter((r) => r.source === 'post');
  const youtube = rows.filter((r) => r.source === 'youtube');
  const sum = (list: typeof rows, k: string) => list.reduce((s, r) => s + n(r, k), 0);
  const postUsd = post.reduce((s, r) => {
    const platform = typeof r.meta?.platform === 'string' ? (r.meta.platform as keyof Prices['usdPerPostRead']) : 'tiktok';
    return s + n(r, 'reads') * (prices.usdPerPostRead[platform] ?? prices.usdPerPostRead.tiktok);
  }, 0);
  return [
    { source: 'x', label: 'X', usd: x.reduce((s, r) => s + Math.max(n(r, 'tweets') * prices.usdPerTweet, n(r, 'requests') * prices.usdPerRequestMin), 0), units: [{ label: 'posts read', n: sum(x, 'tweets') }, { label: 'requests', n: sum(x, 'requests') }] },
    { source: 'tiktok', label: 'TikTok hashtag', usd: sum(tiktok, 'queried') * prices.usdPerHashtag, units: [{ label: 'hashtags queried', n: sum(tiktok, 'queried') }] },
    { source: 'tiktok_search', label: 'TikTok search', usd: sum(search, 'results') * prices.usdPerSearchResult + sum(search, 'reads') * prices.usdPerPostRead.tiktok, units: [{ label: 'searches', n: sum(search, 'searched') }, { label: 'results', n: sum(search, 'results') }, { label: 're-reads', n: sum(search, 'reads') }] },
    { source: 'post', label: 'Captured posts', usd: postUsd, units: [{ label: 'reads', n: sum(post, 'reads') }] },
    { source: 'youtube', label: 'YouTube', usd: 0, units: [{ label: 'searches (quota)', n: sum(youtube, 'searched') }] },
  ];
}

export interface CronHour {
  hour: string;
  fastSlots: number;
  fastMarkets: number;
  slowMarkets: number;
  ok: boolean;
}

export function cronHealth({ fastSeries, snapshots, liveCount, now }: { fastSeries: Map<string, [number, number][]>; snapshots: { market_id: string; recorded_at: string }[]; liveCount: number; now: number }): { hours: CronHour[]; fastLastAt: string | null; slowLastAt: string | null; sentences: string[] } {
  const hourStart = (t: number) => Math.floor(t / HOUR) * HOUR;
  const slots = new Map<number, Set<number>>();
  const fastMarkets = new Map<number, Set<string>>();
  let fastLast = 0;
  for (const [id, points] of fastSeries) {
    for (const [t] of points) {
      const h = hourStart(t);
      (slots.get(h) ?? slots.set(h, new Set()).get(h)!).add(Math.floor((t - h) / (5 * MIN)));
      (fastMarkets.get(h) ?? fastMarkets.set(h, new Set()).get(h)!).add(id);
      if (t > fastLast) fastLast = t;
    }
  }
  const slow = new Map<number, Set<string>>();
  let slowLast = 0;
  for (const s of snapshots) {
    const t = Date.parse(s.recorded_at);
    if (!Number.isFinite(t)) continue;
    const h = hourStart(t);
    (slow.get(h) ?? slow.set(h, new Set()).get(h)!).add(s.market_id);
    if (t > slowLast) slowLast = t;
  }
  const hours: CronHour[] = [];
  const current = hourStart(now);
  for (let i = 0; i < 24; i++) {
    const h = current - i * HOUR;
    const elapsed = i === 0 ? (now - h) / HOUR : 1;
    const fastSlots = slots.get(h)?.size ?? 0;
    const slowMarkets = slow.get(h)?.size ?? 0;
    const expectedSlots = Math.max(1, Math.floor(12 * elapsed));
    // The slow pass runs at :07; before then the hour has nothing to show.
    const slowDue = i > 0 || now - h > 15 * MIN;
    const ok = fastSlots >= Math.min(10, expectedSlots - 2) && (!slowDue || slowMarkets >= 0.9 * liveCount);
    hours.push({ hour: new Date(h).toISOString(), fastSlots, fastMarkets: fastMarkets.get(h)?.size ?? 0, slowMarkets, ok });
  }
  const sentences: string[] = [];
  sentences.push(fastLast ? `Fast refresh last wrote ${fmtAge(now - fastLast)} ago; ${hours[0].fastSlots} of ${Math.max(1, Math.floor(12 * ((now - current) / HOUR)))} five-minute slots so far this hour.` : 'The fast refresh has not written in the last 24 h.');
  sentences.push(slowLast ? `Slow refresh last snapshot ${fmtAge(now - slowLast)} ago, covering ${hours.find((h) => h.slowMarkets > 0)?.slowMarkets ?? 0} of ${liveCount} live markets.` : 'No hourly snapshot in the last 24 h.');
  const bad = hours.filter((h) => !h.ok).length;
  sentences.push(bad === 0 ? 'Every hour in the last day ran in full.' : `${bad} of the last 24 hours missed slots or markets.`);
  return { hours, fastLastAt: fastLast ? new Date(fastLast).toISOString() : null, slowLastAt: slowLast ? new Date(slowLast).toISOString() : null, sentences };
}
