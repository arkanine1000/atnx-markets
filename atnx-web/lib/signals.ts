// Composite VI dispatcher. Nine sources, each reporting an absolute level
// and a momentum ratio, combined by lib/vi/score.ts.
//
// Two refresh cadences share one stored breakdown per market
// (markets.vi_components): the fast path (every 5 min) re-fetches Trends
// and Bluesky and reuses the stored GDELT and Wikipedia readings; the slow
// path (hourly) does the reverse. A fresh capture fetches everything.
import {
  blendScores,
  combine,
  FAST_SOURCES,
  RAMP_MS,
  isGenericTerm,
  isVerifiableAlias,
  rescaleSeed,
  searchableAliases,
  SLOW_SOURCES,
  type CombineOptions,
  type Components,
  type Composite,
  type SourceComponent,
  type SourceName,
} from './vi/score';
import { fetchTrendsSignals, type TrendsSignal } from './vi/trends';
import { fetchBlueskySignal } from './vi/bluesky';
import { GDELT_BQ_SINCE, gdeltApplies, readGdeltSignal } from './vi/gdelt';
import { fetchWikipediaSignal } from './vi/wikipedia';
import { fetchYoutubeSignal } from './vi/youtube';
import { fetchHnSignal } from './vi/hn';
import { fetchDexSignal } from './vi/dex';
import { fetchXSignal } from './vi/x';
import { fetchTiktokSignal, prefetchTiktok } from './vi/tiktok';
import { effectiveYoutube, readChannelMeta, type CreatorHandle } from './creators/channel';
import { readXAccountMeta, type XHandle } from './creators/x-account';

export interface ScoreRequest {
  term: string;
  // Other names people use for it (markets.aliases). Sources search for
  // the name and its aliases together; a canonical meme title is rarely
  // what a post actually says.
  aliases?: string[];
  // Breakdown stored on the market from earlier passes, if any.
  stored?: Components | null;
  // markets.entity_type. Brands may resolve to a company-suffixed
  // Wikipedia article ("Meta Platforms").
  entityType?: string | null;
  // markets.category. Some sources only see part of the world and are
  // asked about the categories they cover (see APPLIES).
  category?: string | null;
  // markets.id, for sources that keep their own sample series.
  marketId?: string | null;
  // Verified own accounts (market_handles), for creator reach: the YouTube
  // channel (lib/creators/channel.ts) and the X account
  // (lib/creators/x-account.ts).
  creator?: { youtubeChannelId?: string | null; xHandle?: string | null; verifiedAt: string | null } | null;
}

// The composite, with the GDELT switch-over ramp: GDELT moved to BigQuery
// (and back to its full weight) at GDELT_BQ_SINCE, and the score walks
// there from the composite without it instead of jumping on one write.
function rampedScore(components: Components, options: CombineOptions, now: number): { composite: Composite | null; score: number | null } {
  const composite = combine(components, options);
  let score = composite?.score ?? null;
  if (composite && components.gdelt && now < GDELT_BQ_SINCE + RAMP_MS) {
    const withoutGdelt: Components = { ...components };
    delete withoutGdelt.gdelt;
    const before = combine(withoutGdelt, options);
    if (before) score = blendScores(before.score, composite.score, GDELT_BQ_SINCE, now);
  }
  return { composite, score };
}

// Sources that only cover some categories. Elsewhere they are not asked
// and count as unknown; a known zero would pull the level down for a
// world the source cannot see.
const APPLIES: Partial<Record<SourceName, (r: ScoreRequest) => boolean>> = {
  hn: (r) => r.category === 'tech' || r.category === 'crypto',
  // A token, not a person or an event in the crypto world: DexScreener
  // has a joke token named after every public figure.
  dex: (r) => r.category === 'crypto' && r.entityType !== 'person' && r.entityType !== 'event',
  // Where people post under a tag: not tech, crypto or politics, which
  // are argued in text elsewhere.
  tiktok: (r) => TIKTOK_CATEGORIES.has(r.category ?? ''),
  // News coverage, except coined meme names (lib/vi/gdelt.ts).
  gdelt: (r) => gdeltApplies(r.category),
};
const TIKTOK_CATEGORIES = new Set(['memes', 'people', 'music', 'film_tv', 'gaming', 'other']);
function applies(name: SourceName, r: ScoreRequest): boolean {
  return APPLIES[name]?.(r) ?? true;
}

// The verified accounts a market is scored with, from market_handles.
export function creatorOf(youtube?: CreatorHandle | null, x?: XHandle | null): ScoreRequest['creator'] {
  if (!youtube && !x) return null;
  return { youtubeChannelId: youtube?.platform_id ?? null, xHandle: x?.handle ?? null, verifiedAt: youtube?.verified_at ?? x?.verified_at ?? null };
}

export interface SignalResult {
  // Null when no source has data. Callers keep the last known value.
  score: number | null;
  composite: Composite | null;
  components: Components;
  // Trends series on the VI axis, for seeding a new market's sparkline.
  seedSeries: { date: string; value: number }[];
  // Sources that answered with a reading on this pass (not stored copies).
  fetched: SourceName[];
}

export type Cadence = 'fast' | 'slow' | 'all';

// How long a stored reading stands in for a source that is not answering.
export const MAX_KEPT_MS = 48 * 3600 * 1000;

const FRESH_FOR: Record<Cadence, SourceName[]> = {
  fast: FAST_SOURCES,
  slow: SLOW_SOURCES,
  all: [...FAST_SOURCES, ...SLOW_SOURCES],
};

// A market with no stored breakdown has never been scored (its capture-time
// scoring did not land). It fetches every source whatever the cadence: on
// the fast pass alone, a single-word name ("Meta") has no Wikipedia title
// yet, the generic-term guard drops both fast sources, and the market
// sits at zero until the hourly pass.
function neverScored(r: ScoreRequest): boolean {
  return !r.stored || Object.keys(r.stored).length === 0;
}

// Sources that answer for many markets in one request are started here,
// before the markets are scored; their adapters await the result. Only
// the slow path calls this: a capture scores one market, and its TikTok
// mapping can wait for the next hourly pass. Returns what was started.
export function prefetchSlowSources(requests: ScoreRequest[]): { tiktokHashtags: number } {
  const tiktokHashtags = prefetchTiktok(
    requests
      .filter((r) => applies('tiktok', r))
      .map((r) => ({ term: r.term, aliases: (r.aliases ?? []), marketId: r.marketId, stored: r.stored?.tiktok ?? null }))
  );
  return { tiktokHashtags };
}

// Scores many terms at once so Trends can batch them.
export async function scoreTerms(
  requests: ScoreRequest[],
  cadence: Cadence
): Promise<SignalResult[]> {
  const fresh = new Set(FRESH_FOR[cadence]);
  const all = new Set(FRESH_FOR.all);

  const trendsRequests = requests.filter((r) => fresh.has('trends') || neverScored(r));
  const trendsMap: Map<string, TrendsSignal> = trendsRequests.length
    ? await fetchTrendsSignals(trendsRequests.map((r) => ({ term: r.term, aliases: searchableAliases(r.aliases ?? [], r.stored?.wikipedia?.meta) }))).catch(() => new Map())
    : new Map();

  return Promise.all(
    requests.map(async ({ term, stored, ...req }) => {
      const want = neverScored({ term, stored, ...req }) ? all : fresh;
      // Search phrases: multi-word aliases, plus the one-word aliases the
      // stored Wikipedia reading vouches for (they land one slow read after
      // Wikipedia verifies them, since it runs alongside X and Trends).
      const aliases = searchableAliases(req.aliases ?? [], stored?.wikipedia?.meta);
      const aliasCandidates = (req.aliases ?? []).filter(isVerifiableAlias);
      const components: Components = { ...(stored ?? {}) };
      const trends = trendsMap.get(term);
      if (trends) components.trends = trends;
      const corporate = req.entityType === 'brand';

      const request = { term, stored, ...req };
      const [bluesky, gdelt, wikipedia, youtube, hn, dex, x, tiktok] = await Promise.all([
        want.has('bluesky') ? fetchBlueskySignal(term, aliases).catch(() => null) : null,
        want.has('gdelt') && applies('gdelt', request) ? readGdeltSignal(req.marketId).catch(() => null) : null,
        want.has('wikipedia') ? fetchWikipediaSignal(term, aliases, { corporate, aliasCandidates }).catch(() => null) : null,
        want.has('youtube')
          ? fetchYoutubeSignal({ term, aliases, marketId: req.marketId, stored: stored?.youtube ?? null, entityType: req.entityType, category: req.category }).catch(() => null)
          : null,
        want.has('hn') && applies('hn', request) ? fetchHnSignal(term).catch(() => null) : null,
        want.has('dex') && applies('dex', request) ? fetchDexSignal(term, req.aliases ?? []).catch(() => null) : null,
        want.has('x')
          ? fetchXSignal({ term, aliases, marketId: req.marketId, stored: stored?.x ?? null, entityType: req.entityType, category: req.category }).catch(() => null)
          : null,
        want.has('tiktok') && applies('tiktok', request)
          ? fetchTiktokSignal({ term, aliases: req.aliases ?? [], marketId: req.marketId, stored: stored?.tiktok ?? null }).catch(() => null)
          : null,
      ]);
      if (bluesky) components.bluesky = bluesky;
      if (gdelt) components.gdelt = gdelt;
      if (wikipedia) components.wikipedia = wikipedia;
      if (youtube) components.youtube = youtube;
      if (hn) components.hn = hn;
      if (dex) components.dex = dex;
      if (x) components.x = x;
      if (tiktok) components.tiktok = tiktok;
      // A category-bound source keeps nothing once the market leaves its
      // category.
      for (const name of ['hn', 'dex', 'tiktok', 'gdelt'] as const) {
        if (components[name] && !applies(name, request)) delete components[name];
      }

      // A source that answered "unknown" this pass must not erase a real
      // earlier reading; keep the stored one. But not forever: a reading
      // older than MAX_KEPT_MS describes a different week, and a market
      // is better scored without it than frozen on it.
      const fetched: SourceName[] = [];
      for (const name of Object.keys(components) as SourceName[]) {
        const c = components[name];
        if (!c) continue;
        // A deliberate unknown (Trends below its resolution) replaces a
        // stored reading instead of falling back to it: the stored one is
        // the old known 0 this unknown exists to retire.
        if (c.level === null && stored?.[name]?.level != null && !c.meta?.below_resolution) components[name] = stored[name];
        else if (c !== stored?.[name] && c.level !== null) fetched.push(name);
        const kept = components[name];
        if (kept && kept === stored?.[name]) {
          if (Date.now() - Date.parse(kept.fetchedAt) > MAX_KEPT_MS) delete components[name];
        }
      }

      // Single common words score big on search and social by accident.
      // Only count those sources when Wikipedia knows the term by that name.
      if (isGenericTerm(term, (components.wikipedia as SourceComponent | undefined)?.meta)) {
        delete components.trends;
        delete components.bluesky;
      }

      const now = Date.now();
      // A creator's own channel, read on the slow paths and carried on the
      // YouTube component so the fast path sees it too.
      if (req.creator?.youtubeChannelId && req.marketId && want.has('youtube')) {
        try {
          const meta = await readChannelMeta(req.marketId, req.creator.youtubeChannelId, now);
          const yt = components.youtube ?? { source: 'youtube' as const, level: null, momentum: null, fetchedAt: new Date(now).toISOString() };
          components.youtube = { ...yt, meta: { ...(yt.meta ?? {}), ...meta } };
        } catch (err) {
          console.error('[creators] channel reading failed', (err as Error).message);
        }
      }
      // The own X account's reach, read on the slow paths and carried on the
      // X component. With no talk reading the slot still exists, at a known
      // zero of talk, so the own reach scores (lib/vi/score.ts xReading).
      if (req.creator?.xHandle && req.marketId && want.has('x')) {
        try {
          const meta = await readXAccountMeta(req.marketId, req.creator.xHandle, now);
          const x = components.x ?? { source: 'x' as const, level: 0, momentum: null, fetchedAt: new Date(now).toISOString() };
          components.x = { ...x, meta: { ...(x.meta ?? {}), ...meta } };
        } catch (err) {
          console.error('[creators:x] account reading failed', (err as Error).message);
        }
      }

      // Internet-native memes rarely get a Wikipedia article: for them "no
      // article" is structural, not a lack of attention, so it scores as
      // unknown instead of pulling the average down (as GDELT's scope
      // does). The stored reading keeps its 0 and its `own` verdict, which
      // the generic-term guard reads. Decided 2026-09-25, pre-launch;
      // revisit with more meme data.
      const scoring: Components = { ...components };
      const wiki = components.wikipedia;
      if (request.category === 'memes' && wiki && wiki.level === 0 && !wiki.meta?.title) {
        scoring.wikipedia = { ...wiki, level: null };
      }

      let { composite, score } = rampedScore(scoring, {}, now);
      // Creator reach: the channel scores the YouTube slot when its (Shorts-
      // discounted) week beats the name search, and the score walks there
      // over the ramp from the handle's verification. The talk sources'
      // zeros need no special case: a zero adds nothing to the total.
      if (req.creator?.youtubeChannelId) {
        const yt = effectiveYoutube(components.youtube);
        if (yt.channel) {
          const creator = rampedScore({ ...scoring, youtube: yt.component }, {}, now);
          if (creator.composite && creator.score !== null) {
            const since = Date.parse(req.creator.verifiedAt ?? '');
            score = score === null ? creator.score : blendScores(score, creator.score, since, now);
            composite = creator.composite;
          }
        }
      }
      // Seed the sparkline only from a Trends reading that counts toward
      // the score, rescaled from Trends' own axis onto the score. A series
      // dropped by the generic-term guard would draw a week of history the
      // score itself refuses to use.
      const seedSeries =
        components.trends && composite && score !== null ? rescaleSeed(trends?.series ?? [], score, composite.shares.trends ?? 0) : [];
      // Persist only the breakdown; the series is for seeding and would
      // bloat the row.
      const persisted: Components = {};
      for (const name of Object.keys(components) as SourceName[]) {
        const c = components[name];
        if (!c) continue;
        const { source, level, momentum, fetchedAt, meta } = c;
        persisted[name] = { source, level, momentum, fetchedAt, meta };
      }

      return { score, composite, components: persisted, seedSeries, fetched };
    })
  );
}

// Single-term convenience for the capture path: every source, fresh.
export async function composeVi(request: ScoreRequest): Promise<SignalResult> {
  const [result] = await scoreTerms([request], 'all');
  return result;
}
