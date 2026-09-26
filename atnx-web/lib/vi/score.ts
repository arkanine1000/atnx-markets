// Pure scoring math for the Virality Index. No I/O here so it can be probed
// and reasoned about in isolation (scripts/vi-probe.ts).
//
// Every source reports two things about a term, each with an absolute
// meaning that does not depend on the term's own history:
//   level     0-1000  how much attention it has right now, on the
//                     source's own log scale (display and diagnostics)
//   momentum  ratio   current window vs the term's own 7-14 day baseline
//                     (the Hype Ratio: 1 = normal, 3 = 3x baseline, cap 10)
// plus the raw reading in its meta (views, posts a day, pageviews...).
// The composite converts each raw reading to YouTube-view-equivalents a
// week (CALIBRATION), sums them over the sources that answered, maps the
// total to 0-1000 with one log (pointsPerDecade per tenfold), and scales
// that level by momentum (0.65x at a collapse, 1x steady, 1.35x at a 10x
// spike). Total attention: a market seen on many platforms adds up, one
// seen only on its own channel gets that channel's full credit.

export type SourceName = 'trends' | 'bluesky' | 'gdelt' | 'wikipedia' | 'youtube' | 'hn' | 'dex' | 'x' | 'tiktok';

export interface SourceComponent {
  source: SourceName;
  // null when the source had no data for this term (unknown, not zero).
  level: number | null;
  // null when there is no baseline to compare against.
  momentum: number | null;
  fetchedAt: string;
  // Small, source-specific facts for display and debugging.
  meta?: Record<string, string | number | null>;
}

export type Components = Partial<Record<SourceName, SourceComponent>>;

// Relative weights for the momentum half of the composite (the level
// half sums raw attention, see CALIBRATION). Renormalised over the sources
// that report a momentum, so only the ratios matter. Search and video
// reach are the broadest views of attention; social, news and the
// encyclopedia each see a narrower world.
export const WEIGHTS: Record<SourceName, number> = {
  trends: 0.3,
  x: 0.25,
  youtube: 0.2,
  tiktok: 0.2,
  bluesky: 0.2,
  wikipedia: 0.15,
  gdelt: 0.15,
  hn: 0.1,
  dex: 0.2,
};

// Which sources the fast (5 min) and slow (hourly) refresh paths own.
// Free, unlimited and quick to answer goes fast; quota-bound, rate-limited
// or daily-resolution goes slow.
export const FAST_SOURCES: SourceName[] = ['trends', 'bluesky', 'dex'];
export const SLOW_SOURCES: SourceName[] = ['gdelt', 'wikipedia', 'youtube', 'hn', 'x', 'tiktok'];

const LEVEL_SHARE = 0.65;
const MOMENTUM_SHARE = 0.35;
export const MOMENTUM_CAP = 10;

export const clamp = (x: number, lo = 0, hi = 1000) => Math.max(lo, Math.min(hi, x));

// Maps a hype ratio to 0-1000: 0.1x -> 0, 1x -> 500, 10x -> 1000. Log
// scale so a halving hurts as much as a doubling helps.
export function momentumScore(ratio: number): number {
  const r = Math.max(0.1, Math.min(MOMENTUM_CAP, ratio));
  return clamp(Math.round(500 + 500 * Math.log10(r)));
}

export interface Composite {
  score: number;
  level: number;
  momentum: number;
  sourcesPresent: SourceName[];
  // Total attention behind the level, in YouTube-view-equivalents a week,
  // and each answering source's share of it.
  attention: number;
  shares: Partial<Record<SourceName, number>>;
  topSource: SourceName | null;
}

export interface CombineOptions {
  calibration?: Calibration;
}

// Null when no source answered (a reading in its own unit, or a known
// zero). Callers must keep the last known score in that case rather than
// writing a zero. A known zero adds nothing to the total but counts as an
// answer, so a market that is zero everywhere scores 0.
export function combine(components: Components, { calibration = CALIBRATION }: CombineOptions = {}): Composite | null {
  const at = attention(components, calibration);
  if (at.answered.length === 0) return null;
  const seeing = (Object.values(components) as (SourceComponent | undefined)[]).filter(
    (c): c is SourceComponent => !!c && (at.terms[c.source] ?? 0) > 0
  );
  if (seeing.length === 0) {
    return { score: 0, level: 0, momentum: 0, sourcesPresent: [], attention: 0, shares: {}, topSource: null };
  }
  const level = levelFromAttention(at.A, calibration);
  const momentum = compositeMomentum(seeing);
  // Momentum scales the level rather than adding to it: a steady 1x leaves
  // the level alone, 10x lifts it by a third, 0.1x cuts it by a third.
  const momentumFactor = LEVEL_SHARE + MOMENTUM_SHARE * (momentum / 500);
  return {
    score: clamp(Math.round(level * momentumFactor)),
    level,
    momentum: Math.round(momentum),
    sourcesPresent: seeing.map((c) => c.source),
    attention: at.A,
    shares: at.shares,
    topSource: at.topSource,
  };
}

// A new market's sparkline is seeded from the Trends series, which is on
// Trends' own axis (500 + 200 * log10 of the ratio to the benchmark).
// Rescaled onto the score: each day's ratio relative to today's moves the
// Trends term alone, the rest of the total stays. Nothing to seed when
// Trends carries no share of the total or reads nothing today. Pure.
export function rescaleSeed(
  series: { date: string; value: number }[],
  score: number,
  trendsShare: number,
  cal: Calibration = CALIBRATION
): { date: string; value: number }[] {
  if (series.length === 0 || !(trendsShare > 0)) return [];
  const last = series[series.length - 1].value;
  if (last <= 0) return [];
  return series.map((p) => {
    const f = p.value <= 0 ? 0 : Math.pow(10, (p.value - last) / 200);
    const delta = cal.pointsPerDecade * Math.log10(Math.max(1e-9, 1 + trendsShare * (f - 1)));
    return { date: p.date, value: clamp(Math.round(score + delta)) };
  });
}

// Exponential smoothing with a fixed half-life, applied on the stored
// series. Replaces the jitter: the chart breathes because the score is
// converging on the latest reading, not because we added noise.
export const EMA_HALF_LIFE_MS = 2 * 60 * 60 * 1000;

//
// The result is kept to two decimals, not rounded to an integer: at the
// five-minute cadence alpha is about 0.03, so an integer round returned
// `prev` unchanged for any move under ~17 points and the stored score
// could never converge. Display rounding happens where it is displayed.
//
// Within SNAP of the target the score becomes the target. Without this the
// two-decimal rounding leaves a gap of 0.005/alpha that never closes: a
// dead market sat at 0.17 forever at the five-minute cadence, and the gap
// grows when writes land seconds apart. Half a point is invisible once
// the display rounds.
export const SNAP = 0.5;
export function smooth(prev: number | null, prevAt: string | null, raw: number, now = Date.now()): number {
  if (prev === null || prevAt === null) return raw;
  const dt = Math.max(0, now - new Date(prevAt).getTime());
  const alpha = 1 - Math.pow(2, -dt / EMA_HALF_LIFE_MS);
  const next = prev + (raw - prev) * alpha;
  if (Math.abs(next - raw) < SNAP) return raw;
  return Math.round(next * 100) / 100;
}

// Merges the breakdown a pass is about to write with the one on the row.
// The fast and slow passes read a market minutes before they write it, so
// each would overwrite the other's fresher reading. Per source, the newer
// fetchedAt wins; a source the pass left out stays out (the generic-term
// guard drops sources on purpose).
// A change to how a market is scored (a new source, a new weighting) can
// roll in over RAMP_MS instead of landing in one write: positions
// liquidate on every write of current_vi, and a jump of a few hundred
// points would take out leveraged positions that the old score justified.
// Linear from the old score at `since` to the new one at `since + spanMs`.
// Pure.
//
// Off (0) while the platform is unpublished: a ramp also hands anyone a
// known future price for two days, and protecting positions does not
// matter yet. Changes land through the two-hour smoothing instead. Set it
// back (48 h) before launch if method changes should protect holders.
export const RAMP_MS = 0;
export function blendScores(oldScore: number, newScore: number, since: number, now: number, spanMs = RAMP_MS): number {
  if (!Number.isFinite(since) || now >= since + spanMs) return newScore;
  if (now <= since) return oldScore;
  const t = (now - since) / spanMs;
  return Math.round(oldScore + (newScore - oldScore) * t);
}

export function mergeComponents(current: Components | null | undefined, ours: Components): Components {
  const merged: Components = {};
  for (const name of Object.keys(ours) as SourceName[]) {
    const mine = ours[name];
    if (!mine) continue;
    const theirs = current?.[name];
    merged[name] =
      theirs && Date.parse(theirs.fetchedAt) > Date.parse(mine.fetchedAt) ? theirs : mine;
  }
  return merged;
}

// The six tiers from the design doc.
export interface Tier {
  label: string;
  min: number;
}
export const TIERS: Tier[] = [
  { label: 'Mega-viral', min: 851 },
  { label: 'Highly viral', min: 651 },
  { label: 'Viral', min: 451 },
  { label: 'Trending', min: 251 },
  { label: 'Moderate', min: 101 },
  { label: 'Minimal', min: 0 },
];
export function viTier(score: number): Tier {
  return TIERS.find((t) => score >= t.min) ?? TIERS[TIERS.length - 1];
}

// Shared helper: ratio of the latest full window to the mean of the prior
// ones. Null when the prior mean is zero (nothing to compare against).
export function ratioToBaseline(current: number, prior: number[]): number | null {
  const kept = prior.filter((v) => Number.isFinite(v));
  if (kept.length === 0) return null;
  const mean = kept.reduce((a, b) => a + b, 0) / kept.length;
  if (mean <= 0) return current > 0 ? MOMENTUM_CAP : null;
  return current / mean;
}

export function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Terms that are one common word ("The", "Cat") score huge on search and
// social by accident. A single token only counts on those sources when an
// encyclopedic source resolved it to an article of the same name.
//
// `wiki` is the Wikipedia component's meta. Readings written since the
// resolver learned about redirects and disambiguation pages carry `own`:
// 1 when the article is the term's own subject ("Clavicular (influencer)",
// "Meta Platforms" for a brand, or a coined name that redirects into a
// broader article), 0 when it is not (a disambiguation page, a common
// word's article). Older readings only have the title, compared by name.
export function isGenericTerm(
  term: string,
  wiki: { title?: string | number | null; own?: string | number | null } | null | undefined
): boolean {
  const tokens = term.trim().split(/\s+/).filter(Boolean);
  if (tokens.length >= 2) return false;
  // Function words have Wikipedia articles too ("The"), so an article match
  // is not enough on its own.
  if (tokens.length === 0 || FUNCTION_WORDS.has(tokens[0].toLowerCase())) return true;
  if (wiki?.own !== undefined && wiki.own !== null) return Number(wiki.own) !== 1;
  const title = typeof wiki?.title === 'string' ? wiki.title : null;
  if (!title) return true;
  return title.trim().toLowerCase() !== term.trim().toLowerCase();
}

// An alias is used as a search phrase. A single word matches far more
// than the subject, whatever its length: "Verity" (an ARG) found a novel
// and everyone with that name, "Alphabet" (Google) found alphabets. Only
// multi-word aliases are searchable, plus single tokens that carry a
// digit, a symbol or an internal capital ("atnx.app", "7x7", "AndrewTate"),
// which are handles and codes, not words.
export function isSearchableAlias(alias: string): boolean {
  const tokens = alias.trim().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return false;
  if (tokens.length >= 2) return true;
  const t = tokens[0];
  return (/[^a-z]/i.test(t) || /[a-z][A-Z]/.test(t)) && !FUNCTION_WORDS.has(t.toLowerCase());
}

// A plain one-word alias that Wikipedia could vouch for ("Trump"): not a
// search phrase by itself, not a function word.
export function isVerifiableAlias(alias: string): boolean {
  const tokens = alias.trim().split(/\s+/).filter(Boolean);
  return tokens.length === 1 && !alias.includes(',') && !FUNCTION_WORDS.has(tokens[0].toLowerCase()) && !isSearchableAlias(alias);
}

// The aliases a source may search for. Multi-word aliases and handles
// pass (isSearchableAlias). A one-word alias passes only when the stored
// Wikipedia reading vouches for it: meta.alias_ok lists the aliases that
// redirect to the market's own article ("Trump" -> Donald Trump), so the
// word means the subject and nothing else. People are otherwise read by
// their full name only, while one-word brands (Google, Meta) get their
// whole volume. Order is kept: X, Bluesky and YouTube search the first few.
export function searchableAliases(aliases: string[], wiki?: SourceComponent['meta'] | null): string[] {
  const ok = new Set(
    typeof wiki?.alias_ok === 'string' && Number(wiki.own) === 1
      ? wiki.alias_ok.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
      : []
  );
  return aliases.filter((a) => isSearchableAlias(a) || (isVerifiableAlias(a) && ok.has(a.trim().toLowerCase())));
}

const FUNCTION_WORDS = new Set([
  'problem', 'trend', 'reaction', 'edit', 'edits', 'moment', 'face',
  'the', 'a', 'an', 'and', 'or', 'but', 'of', 'in', 'on', 'at', 'to', 'for',
  'by', 'with', 'from', 'as', 'is', 'was', 'are', 'were', 'be', 'been', 'it',
  'its', 'this', 'that', 'these', 'those', 'he', 'she', 'they', 'we', 'you',
  'i', 'me', 'my', 'your', 'his', 'her', 'their', 'our', 'not', 'no', 'yes',
  'so', 'if', 'then', 'than', 'too', 'very', 'can', 'will', 'just', 'now',
  'new', 'one', 'all', 'any', 'some', 'more', 'most', 'other', 'such', 'what',
  'which', 'who', 'when', 'where', 'why', 'how', 'up', 'down', 'out', 'over',
  'meme', 'memes', 'trend', 'trending', 'viral', 'video', 'image', 'photo',
]);

// ---------------------------------------------------------------------------
// Total-attention model, calibrated 2026-09-26 against eyeballed anchors
// (see scripts/vi-calibrate.ts). Each source's raw reading is converted to
// YouTube-view-equivalents a week, the terms are summed over the sources
// that answered, and one log maps the total to 0-1000. Unknown sources are
// absent; a known zero adds nothing. Video volume (YouTube views, TikTok
// videos) enters sub-linearly: a passive view is cheaper attention than a
// search or a post. `combine` sums these terms.

export interface UnitScale {
  // term = k * reading^q, in YouTube-view-equivalents per week
  k: number;
  q: number;
}

export interface Calibration {
  version: string;
  // VI points per tenfold increase of total attention.
  pointsPerDecade: number;
  // log10 of the total at which the level is 0.
  log10ZeroPoint: number;
  // A channel whose recent uploads are mostly Shorts counts a swiped
  // Short like a long-form view; its views are discounted.
  shorts: { maxSeconds: number; firstShare: number; discount: number };
  units: Record<SourceName, UnitScale | null>;
}

export const CALIBRATION: Calibration = {
  version: 'sum-v1-2026-09-26',
  pointsPerDecade: 325,
  log10ZeroPoint: 5.64,
  shorts: { maxSeconds: 180, firstShare: 2 / 3, discount: 0.25 },
  units: {
    youtube: { k: 10 ** 3.14, q: 0.51 }, // views a week: name search or the discounted channel, whichever is larger
    tiktok: { k: 10 ** 5.89, q: 0.51 }, // videos a day under the hashtag
    trends: { k: 1.03e7, q: 1 }, // ratio to the benchmark query
    x: { k: 2527, q: 1 }, // posts a day
    bluesky: { k: 717, q: 1 }, // posts a day
    wikipedia: { k: 78, q: 1 }, // pageviews a day (14-day median)
    gdelt: { k: 4.7e7, q: 1 }, // share (%) of the week's news articles
    hn: { k: 3275, q: 1 }, // hits a day
    dex: null, // uncalibrated (one market has it); not scored
  },
};

export function isShortsFirst(share: number | null | undefined, cal: Calibration = CALIBRATION): boolean {
  return typeof share === 'number' && Number.isFinite(share) && share >= cal.shorts.firstShare;
}

export const metaNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

// The week's views a creator market's YouTube slot stands for: the name
// search or the own channel, whichever is larger (they overlap). A Shorts-
// first channel is discounted before the power.
export function youtubeReading(meta: SourceComponent['meta'] | undefined, cal: Calibration = CALIBRATION): number | null {
  const search = metaNumber(meta?.views_7d);
  const channel = metaNumber(meta?.channel_views_7d);
  if (search === null && channel === null) return null;
  const discounted = channel === null ? 0 : channel * (isShortsFirst(metaNumber(meta?.channel_shorts_share), cal) ? cal.shorts.discount : 1);
  return Math.max(search ?? 0, discounted);
}

// A source's raw reading in its own unit (see CALIBRATION.units), or null
// when the source is unknown, not scored, or has a level but no raw meta.
export function sourceReading(c: SourceComponent, cal: Calibration = CALIBRATION): number | null {
  if (c.level === null || !cal.units[c.source]) return null;
  const m = c.meta;
  let r: number | null;
  switch (c.source) {
    case 'youtube':
      r = youtubeReading(m, cal);
      break;
    case 'tiktok': {
      const h = metaNumber(m?.videos_per_h);
      r = h === null ? null : h * 24;
      break;
    }
    case 'trends':
      r = metaNumber(m?.ratio_to_benchmark);
      break;
    case 'x': {
      const h = metaNumber(m?.rate_per_h);
      r = h === null ? null : h * 24;
      break;
    }
    case 'bluesky':
      r = metaNumber(m?.posts_24h);
      break;
    case 'wikipedia': {
      const med = metaNumber(m?.views_median_14d);
      r = med !== null && med > 0 ? med : metaNumber(m?.views_latest);
      break;
    }
    case 'gdelt':
      r = metaNumber(m?.articles_pct_7d);
      break;
    case 'hn':
      r = metaNumber(m?.hits_24h);
      break;
    default:
      r = null;
  }
  // A known zero without raw fields (no article, an empty search) is a zero.
  if (r === null) return c.level === 0 ? 0 : null;
  return Math.max(0, r);
}

export interface Attention {
  // Total, in YouTube-view-equivalents a week.
  A: number;
  terms: Partial<Record<SourceName, number>>;
  shares: Partial<Record<SourceName, number>>;
  answered: SourceName[];
  topSource: SourceName | null;
  topShare: number;
}

export function attention(components: Components, cal: Calibration = CALIBRATION): Attention {
  const terms: Partial<Record<SourceName, number>> = {};
  const answered: SourceName[] = [];
  let A = 0;
  for (const c of Object.values(components) as (SourceComponent | undefined)[]) {
    if (!c) continue;
    const r = sourceReading(c, cal);
    const u = cal.units[c.source];
    if (r === null || !u) continue;
    answered.push(c.source);
    const t = r > 0 ? u.k * Math.pow(r, u.q) : 0;
    terms[c.source] = t;
    A += t;
  }
  const shares: Partial<Record<SourceName, number>> = {};
  let topSource: SourceName | null = null;
  let topShare = 0;
  for (const [s, t] of Object.entries(terms) as [SourceName, number][]) {
    const share = A > 0 ? t / A : 0;
    shares[s] = share;
    if (share > topShare) {
      topShare = share;
      topSource = s;
    }
  }
  return { A, terms, shares, answered, topSource, topShare };
}

// The breakdown a page can show: the total in YouTube-view-equivalents a
// week, each answering source's share (3 decimals), the largest, and
// which sources answered and saw something. Null when nothing answered.
export interface AttentionSummary {
  total: number;
  shares: Partial<Record<SourceName, number>>;
  top: SourceName | null;
  answered: SourceName[];
  seeing: SourceName[];
}

export function summarizeAttention(components: Components | null | undefined, cal: Calibration = CALIBRATION): AttentionSummary | null {
  if (!components) return null;
  const at = attention(components, cal);
  if (at.answered.length === 0) return null;
  const shares: Partial<Record<SourceName, number>> = {};
  for (const [s, v] of Object.entries(at.shares) as [SourceName, number][]) if (v > 0) shares[s] = Math.round(v * 1000) / 1000;
  return {
    total: Math.round(at.A),
    shares,
    top: at.topSource,
    answered: at.answered,
    seeing: (Object.entries(at.terms) as [SourceName, number][]).filter(([, t]) => t > 0).map(([s]) => s),
  };
}

// Total attention to the 0-1000 level: pointsPerDecade per tenfold,
// zero at the zero point.
export function levelFromAttention(A: number, cal: Calibration = CALIBRATION): number {
  if (A <= 0) return 0;
  return clamp(Math.round(cal.pointsPerDecade * (Math.log10(A) - cal.log10ZeroPoint)));
}

// The momentum half of the composite, on the 0-1000 momentum axis:
// WEIGHTS-weighted momentumScore over the sources that see something and
// have a baseline; steady (500) when none has one.
export function compositeMomentum(seeing: SourceComponent[]): number {
  const withMomentum = seeing.filter((c) => c.momentum !== null);
  if (withMomentum.length === 0) return 500;
  const mw = withMomentum.reduce((s, c) => s + WEIGHTS[c.source], 0);
  return withMomentum.reduce((s, c) => s + (WEIGHTS[c.source] / mw) * momentumScore(c.momentum as number), 0);
}
