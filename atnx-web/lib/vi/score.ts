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
// total to a level with one log (pointsPerDecade per tenfold), and scales
// that level by momentum (0.65x at a collapse, 1x steady, 1.35x at a 10x
// spike). Total attention: a market seen on many platforms adds up, one
// seen only on its own channel gets that channel's full credit.
//
// The level has a floor of 0 and no ceiling. 1000 is where the giants
// sit (about 2.4e8 view-equivalents a week), not the top of the scale:
// Google reads about 1100, a Super Bowl week would read about 1500.
// A hard cap at 1000 made the giants tie, hid a spike on a saturated
// market, and left a long opened at 1000 with nothing to win. PnL and
// liquidation are relative to the entry, so nothing needs a bound.

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

// Per-source levels and the momentum axis stay on 0-1000. The composite
// level and score use `floor` instead: 0 at the bottom, open at the top.
export const clamp = (x: number, lo = 0, hi = 1000) => Math.max(lo, Math.min(hi, x));
export const floor = (x: number) => Math.max(0, x);

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
  const momentum = compositeMomentum(seeing, at.shares);
  // Momentum scales the level rather than adding to it: a steady 1x leaves
  // the level alone, 10x lifts it by a third, 0.1x cuts it by a third.
  const momentumFactor = LEVEL_SHARE + MOMENTUM_SHARE * (momentum / 500);
  return {
    score: floor(Math.round(level * momentumFactor)),
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
    return { date: p.date, value: floor(Math.round(score + delta)) };
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

// Works whose name is an everyday word: the search sources drop the bare
// name and read the aliases only. "Cars" the 2006 film went live at 854,
// Mega-viral, on Trends for cars the vehicles and TikTok's #cars. The
// stored Wikipedia reading already says the bare name is not the subject:
// a 'qualified' match means the plain title belonged to something else
// and the article lives at "Cars (film)". Applied only to works (films,
// shows, games, music; never people or brands: "Meta" is also a qualified
// title, "Meta Platforms", yet people search the bare word for the
// company) with at least one searchable alias to fall back on. Wikipedia
// itself keeps the bare name, which is how it found the article. Pure.
const WORK_CATEGORIES = new Set(['film_tv', 'gaming', 'music']);
export function searchTerms(
  term: string,
  aliases: string[],
  { wiki, entityType, category }: { wiki?: SourceComponent['meta'] | null; entityType?: string | null; category?: string | null }
): { term: string; aliases: string[] } {
  const isWork = WORK_CATEGORIES.has(category ?? '') && entityType !== 'person' && entityType !== 'brand';
  const bareNameIsOther = Number(wiki?.own) === 1 && wiki?.match === 'qualified';
  if (isWork && bareNameIsOther && aliases.length > 0) return { term: aliases[0], aliases: aliases.slice(1) };
  return { term, aliases };
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
// that answered, and one log maps the total to the level. Unknown sources are
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
  // A swiped Short counts as a view like a long-form one, so a channel's
  // views are discounted in proportion to its share of Shorts among
  // recent uploads: all Shorts x discount, none x1, linear in between.
  shorts: { maxSeconds: number; discount: number };
  // Posts a day x this stand in for X impressions on a reading written
  // before views_per_h existed (lib/vi/x.ts); gone once every market has
  // been re-read.
  xImpressionsPerPostFallback: number;
  // A creator's own-channel views count this much of a view of talk about
  // them: consumption of the content is a weaker signal of attention on
  // the person than a mention or a search. Fitted against the anchors.
  ownChannelFactor: number;
  units: Record<SourceName, UnitScale | null>;
}

export const DEFAULT_CALIBRATION: Calibration = {
  // Refit 2026-09-27 16:05 UTC on a day of readings under #48 and #50,
  // TikTok in views a day and the own-channel factor free
  // (npm run vi:calibrate): 16 anchors, leave-one-out RMSE 93, in-sample 67.
  version: 'sum-v1-2026-09-27c',
  pointsPerDecade: 391.3,
  log10ZeroPoint: 5.828,
  shorts: { maxSeconds: 180, discount: 0.25 },
  xImpressionsPerPostFallback: 300,
  ownChannelFactor: 0.694,
  units: {
    youtube: { k: 454, q: 0.568 }, // views a week: name search or the discounted channel, whichever is larger
    // Views a day gained under the hashtag. Half the fitted 977: the anchors
    // do not pin what a TikTok view is worth against a search or a news
    // mention, so this is set by judgement (2026-09-27, with the user):
    // the meme band sits with Anthropic and under Bitcoin, MrBeast on his
    // target. Move to a quarter once own-account X reach carries Musk.
    tiktok: { k: 488.5, q: 0.568 },
    x: { k: 871, q: 0.568 }, // impressions a day on posts about the name (matured two hours)
    trends: { k: 1.445e7, q: 1 }, // ratio to the benchmark query
    bluesky: { k: 703, q: 1 }, // posts a day
    wikipedia: { k: 75.89, q: 1 }, // pageviews a day (14-day median)
    gdelt: { k: 3.822e7, q: 1 }, // share (%) of the week's news articles
    hn: { k: 3254, q: 1 }, // hits a day
    dex: null, // uncalibrated (one market has it); not scored
  },
};

// VI_CALIBRATION_JSON overrides any of the fields above without a deploy
// (a refit is an env change, a bad constant rolls back in a minute).
// Top-level fields replace; `units` merges per source, so one source can
// be given without repeating the rest. Malformed JSON is logged and
// ignored. Pure.
export function applyCalibrationOverride(base: Calibration, json: string | undefined | null): Calibration {
  if (!json || !json.trim()) return base;
  let o: Partial<Calibration> & { units?: Partial<Record<SourceName, UnitScale | null>> };
  try {
    o = JSON.parse(json);
  } catch (err) {
    console.error(`[vi] VI_CALIBRATION_JSON is not valid JSON: ${(err as Error).message}`);
    return base;
  }
  if (!o || typeof o !== 'object') return base;
  const num = (v: unknown, d: number) => (typeof v === 'number' && Number.isFinite(v) ? v : d);
  const units = { ...base.units };
  for (const [s, u] of Object.entries(o.units ?? {}) as [SourceName, UnitScale | null | undefined][]) {
    if (!(s in base.units)) continue;
    if (u === null) units[s] = null;
    else if (u && typeof u === 'object') units[s] = { k: num(u.k, base.units[s]?.k ?? 1), q: num(u.q, base.units[s]?.q ?? 1) };
  }
  return {
    version: typeof o.version === 'string' ? o.version : `${base.version}+env`,
    pointsPerDecade: num(o.pointsPerDecade, base.pointsPerDecade),
    log10ZeroPoint: num(o.log10ZeroPoint, base.log10ZeroPoint),
    shorts: { maxSeconds: num(o.shorts?.maxSeconds, base.shorts.maxSeconds), discount: num(o.shorts?.discount, base.shorts.discount) },
    xImpressionsPerPostFallback: num(o.xImpressionsPerPostFallback, base.xImpressionsPerPostFallback),
    ownChannelFactor: num(o.ownChannelFactor, base.ownChannelFactor),
    units,
  };
}

export const CALIBRATION: Calibration = applyCalibrationOverride(DEFAULT_CALIBRATION, process.env.VI_CALIBRATION_JSON);

// The factor a channel's views are multiplied by for its share of Shorts
// among recent uploads: 1 at no Shorts, `discount` at all Shorts, linear
// in between; 1 when the share is unknown.
export function shortsFactor(share: number | null | undefined, cal: Calibration = CALIBRATION): number {
  if (typeof share !== 'number' || !Number.isFinite(share)) return 1;
  const s = Math.max(0, Math.min(1, share));
  return 1 - (1 - cal.shorts.discount) * s;
}

export const metaNumber = (v: unknown): number | null => {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = parseFloat(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
};

// A creator's own channel views as attention on the creator: the Shorts
// discount, then the own-channel factor. Pure.
export function channelViewsAsAttention(meta: SourceComponent['meta'] | undefined, cal: Calibration = CALIBRATION): number | null {
  const channel = metaNumber(meta?.channel_views_7d);
  if (channel === null) return null;
  return channel * shortsFactor(metaNumber(meta?.channel_shorts_share), cal) * cal.ownChannelFactor;
}

// The week's views a creator market's YouTube slot stands for: the name
// search or the own channel (Shorts-discounted, own-channel factor),
// whichever is larger (they overlap). Before the power.
export function youtubeReading(meta: SourceComponent['meta'] | undefined, cal: Calibration = CALIBRATION): number | null {
  const search = metaNumber(meta?.views_7d);
  const channel = channelViewsAsAttention(meta, cal);
  if (search === null && channel === null) return null;
  return Math.max(search ?? 0, channel ?? 0);
}

// Impressions a day on posts about the name (lib/vi/x.ts; a reading from
// before views were kept stands in with posts x a typical count), or the
// account's own posts' impressions (lib/creators/x-account.ts) times the
// own-channel factor, whichever is larger. Pure.
export function xReading(meta: SourceComponent['meta'] | undefined, cal: Calibration = CALIBRATION): number | null {
  let talk: number | null = null;
  const v = metaNumber(meta?.views_per_h);
  if (v !== null) talk = v * 24;
  else {
    const h = metaNumber(meta?.rate_per_h);
    if (h !== null) talk = h * 24 * cal.xImpressionsPerPostFallback;
  }
  const ownPerHour = metaNumber(meta?.own_views_per_h);
  const own = ownPerHour === null ? null : ownPerHour * 24 * cal.ownChannelFactor;
  if (talk === null && own === null) return null;
  return Math.max(talk ?? 0, own ?? 0);
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
      // Views a day gained under the tag (lib/vi/tiktok.ts); a reading
      // from before the view trend existed stands in with videos a day
      // times the tag's lifetime views per video.
      const v = metaNumber(m?.views_per_h);
      if (v !== null) r = v * 24;
      else {
        const h = metaNumber(m?.videos_per_h);
        const vt = metaNumber(m?.views_total);
        const nt = metaNumber(m?.videos_total);
        r = h === null ? null : vt !== null && nt !== null && nt > 0 ? h * 24 * (vt / nt) : null;
      }
      break;
    }
    case 'trends':
      r = metaNumber(m?.ratio_to_benchmark);
      break;
    case 'x':
      r = xReading(m, cal);
      break;
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

// Total attention to the level: pointsPerDecade per tenfold, through
// log10(1 + A/A0), no ceiling. Far above the zero point that is the
// plain log; around and below it the level bends to 0 instead of cutting
// off, so a market with a little attention reads a little (A0/10 -> ~13,
// A0 -> ~98) and only nothing at all reads 0.
export function levelFromAttention(A: number, cal: Calibration = CALIBRATION): number {
  if (A <= 0) return 0;
  return Math.round(cal.pointsPerDecade * Math.log10(1 + A / 10 ** cal.log10ZeroPoint));
}

// The momentum half of the composite, on the 0-1000 momentum axis:
// momentumScore over the sources that see something and have a
// baseline, weighted by each one's share of the total (`shares`), so a
// spike on a source that is 2% of a market's attention moves it 2% of
// the way. WEIGHTS stand in when no shares are given. Steady (500) when
// no source has a baseline.
export function compositeMomentum(seeing: SourceComponent[], shares?: Partial<Record<SourceName, number>>): number {
  const withMomentum = seeing.filter((c) => c.momentum !== null);
  if (withMomentum.length === 0) return 500;
  const w = (c: SourceComponent) => (shares ? (shares[c.source] ?? 0) : WEIGHTS[c.source]);
  const mw = withMomentum.reduce((s, c) => s + w(c), 0);
  if (mw <= 0) return 500;
  return withMomentum.reduce((s, c) => s + (w(c) / mw) * momentumScore(c.momentum as number), 0);
}
