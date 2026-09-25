// Pure scoring math for the Virality Index. No I/O here so it can be probed
// and reasoned about in isolation (scripts/vi-probe.ts).
//
// Every source reports two things about a term, each with an absolute
// meaning that does not depend on the term's own history:
//   level     0-1000  how much attention it has right now
//   momentum  ratio   current window vs the term's own 7-14 day baseline
//                     (the Hype Ratio: 1 = normal, 3 = 3x baseline, cap 10)
// The composite weights the sources that actually returned data, scales
// the level by momentum (0.65x at a collapse, 1x steady, 1.35x at a 10x
// spike), then by how many independent sources see the term at all.

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

// Relative weights; the composite renormalises over the sources that
// answered, so only the ratios matter. Search and video reach are the
// broadest views of attention; social, news and the encyclopedia each
// see a narrower world. HN and DexScreener only answer for the
// categories they cover (tech, crypto) and count as unknown elsewhere.
// GDELT is down-weighted for reliability, not relevance: its API is
// throttled by design and answers some hours and not others.
export const WEIGHTS: Record<SourceName, number> = {
  trends: 0.3,
  x: 0.25,
  youtube: 0.2,
  tiktok: 0.2,
  bluesky: 0.2,
  wikipedia: 0.15,
  gdelt: 0.1,
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

// Presence multiplier: the doc's cross-platform confirmation. One source
// seeing a term is weak evidence; four or more independent ones is strong.
// Capped there so adding sources widens what the index can see without
// inflating every score.
const PRESENCE: Record<number, number> = { 0: 0, 1: 0.8, 2: 0.95, 3: 1.05, 4: 1.2 };
export function presence(seeing: number): number {
  return PRESENCE[Math.min(4, seeing)];
}

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
  multiplier: number;
}

export interface CombineOptions {
  // Sources whose known zero is treated as unknown instead of pulling the
  // level down. For a creator whose audience is on their own channels, the
  // sources that count talk about them read zero because nobody writes
  // their name, not because nothing is happening.
  ignoreZeros?: readonly SourceName[];
}

// Null when no source has data. Callers must keep the last known score in
// that case rather than writing a zero.
export function combine(components: Components, { ignoreZeros = [] }: CombineOptions = {}): Composite | null {
  // "Known" sources answered; "seeing" sources found any attention at all.
  // A known zero counts against the level but earns no momentum credit and
  // no presence credit: nothing is happening there.
  const known = (Object.values(components) as SourceComponent[]).filter(
    (c): c is SourceComponent => !!c && c.level !== null && !(c.level === 0 && ignoreZeros.includes(c.source))
  );
  if (known.length === 0) return null;
  const seeing = known.filter((c) => (c.level as number) > 0);

  const wsum = known.reduce((s, c) => s + WEIGHTS[c.source], 0);
  const level = known.reduce((s, c) => s + (WEIGHTS[c.source] / wsum) * (c.level as number), 0);

  if (seeing.length === 0) {
    return { score: 0, level: 0, momentum: 0, sourcesPresent: [], multiplier: 0 };
  }

  const withMomentum = seeing.filter((c) => c.momentum !== null);
  let momentum: number;
  if (withMomentum.length === 0) {
    momentum = 500; // seen, but no baseline anywhere: assume steady
  } else {
    const mw = withMomentum.reduce((s, c) => s + WEIGHTS[c.source], 0);
    momentum = withMomentum.reduce(
      (s, c) => s + (WEIGHTS[c.source] / mw) * momentumScore(c.momentum as number),
      0
    );
  }

  // Momentum scales the level rather than adding to it: a steady 1x leaves
  // the level alone, 10x lifts it by a third, 0.1x cuts it by a third. An
  // additive term gave every market seen by one source a floor of ~140
  // (0.35 x 500 x 0.8) whatever its size.
  const multiplier = presence(seeing.length);
  const momentumFactor = LEVEL_SHARE + MOMENTUM_SHARE * (momentum / 500);
  const score = clamp(Math.round(level * momentumFactor * multiplier));

  return {
    score,
    level: Math.round(level),
    momentum: Math.round(momentum),
    sourcesPresent: seeing.map((c) => c.source),
    multiplier,
  };
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
// A change to how a market is scored (a new source, a new weighting) rolls
// in over RAMP_MS instead of landing in one write: positions liquidate on
// every write of current_vi, and a jump of a few hundred points would take
// out leveraged positions that the old score justified. Linear from the old
// score at `since` to the new one at `since + spanMs`. Pure.
export const RAMP_MS = 48 * 3600 * 1000;
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
