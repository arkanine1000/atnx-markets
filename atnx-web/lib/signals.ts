// Composite VI dispatcher. Nine sources, each reporting an absolute level
// and a momentum ratio, combined by lib/vi/score.ts.
//
// Two refresh cadences share one stored breakdown per market
// (markets.vi_components): the fast path (every 5 min) re-fetches Trends
// and Bluesky and reuses the stored GDELT and Wikipedia readings; the slow
// path (hourly) does the reverse. A fresh capture fetches everything.
import {
  combine,
  FAST_SOURCES,
  isGenericTerm,
  isSearchableAlias,
  SLOW_SOURCES,
  type Components,
  type Composite,
  type SourceComponent,
  type SourceName,
} from './vi/score';
import { fetchTrendsSignals, type TrendsSignal } from './vi/trends';
import { fetchBlueskySignal } from './vi/bluesky';
import { fetchGdeltSignal } from './vi/gdelt';
import { fetchWikipediaSignal } from './vi/wikipedia';
import { fetchYoutubeSignal } from './vi/youtube';
import { fetchHnSignal } from './vi/hn';
import { fetchDexSignal } from './vi/dex';
import { fetchXSignal } from './vi/x';
import { fetchTiktokSignal, prefetchTiktok } from './vi/tiktok';

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
};
const TIKTOK_CATEGORIES = new Set(['memes', 'people', 'music', 'film_tv', 'gaming', 'other']);
function applies(name: SourceName, r: ScoreRequest): boolean {
  return APPLIES[name]?.(r) ?? true;
}

export interface ScoreOptions {
  // Epoch ms after which no GDELT request starts (the reading is then
  // unknown and the stored one kept). 0 skips GDELT altogether.
  gdeltDeadline?: number;
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
  cadence: Cadence,
  { gdeltDeadline }: ScoreOptions = {}
): Promise<SignalResult[]> {
  const fresh = new Set(FRESH_FOR[cadence]);
  const all = new Set(FRESH_FOR.all);

  const trendsRequests = requests.filter((r) => fresh.has('trends') || neverScored(r));
  const trendsMap: Map<string, TrendsSignal> = trendsRequests.length
    ? await fetchTrendsSignals(trendsRequests.map((r) => ({ term: r.term, aliases: (r.aliases ?? []).filter(isSearchableAlias) }))).catch(() => new Map())
    : new Map();

  return Promise.all(
    requests.map(async ({ term, stored, ...req }) => {
      const want = neverScored({ term, stored, ...req }) ? all : fresh;
      const aliases = (req.aliases ?? []).filter(isSearchableAlias);
      const components: Components = { ...(stored ?? {}) };
      const trends = trendsMap.get(term);
      if (trends) components.trends = trends;
      const corporate = req.entityType === 'brand';

      const request = { term, stored, ...req };
      const [bluesky, gdelt, wikipedia, youtube, hn, dex, x, tiktok] = await Promise.all([
        want.has('bluesky') ? fetchBlueskySignal(term, aliases).catch(() => null) : null,
        want.has('gdelt') && gdeltDeadline !== 0
          ? fetchGdeltSignal(term, aliases, { deadline: gdeltDeadline }).catch(() => null)
          : null,
        want.has('wikipedia') ? fetchWikipediaSignal(term, aliases, { corporate }).catch(() => null) : null,
        want.has('youtube')
          ? fetchYoutubeSignal({ term, aliases, marketId: req.marketId, stored: stored?.youtube ?? null }).catch(() => null)
          : null,
        want.has('hn') && applies('hn', request) ? fetchHnSignal(term).catch(() => null) : null,
        want.has('dex') && applies('dex', request) ? fetchDexSignal(term, req.aliases ?? []).catch(() => null) : null,
        want.has('x') ? fetchXSignal({ term, aliases, marketId: req.marketId }).catch(() => null) : null,
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
      for (const name of ['hn', 'dex', 'tiktok'] as const) {
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
        if (c.level === null && stored?.[name]?.level != null) components[name] = stored[name];
        else if (c !== stored?.[name] && c.level !== null) fetched.push(name);
        const kept = components[name];
        if (kept && kept === stored?.[name]) {
          if (Date.now() - Date.parse(kept.fetchedAt) > MAX_KEPT_MS) {
            delete components[name];
          } else if (name === 'gdelt' && kept.meta?.resolution === undefined && kept.momentum !== null) {
            // A GDELT reading from before the daily-bucketing fix (no
            // `resolution` in its meta) compared one hour to the rest and
            // read a collapse. Its level is fine; its momentum is not.
            components.gdelt = { ...kept, momentum: null };
          }
        }
      }

      // Single common words score big on search and social by accident.
      // Only count those sources when Wikipedia knows the term by that name.
      if (isGenericTerm(term, (components.wikipedia as SourceComponent | undefined)?.meta)) {
        delete components.trends;
        delete components.bluesky;
      }

      const composite = combine(components);
      // Seed the sparkline only from a Trends reading that counts toward
      // the score. A series dropped by the generic-term guard would draw
      // a week of history the score itself refuses to use.
      const seedSeries = components.trends ? (trends?.series ?? []) : [];
      // Persist only the breakdown; the series is for seeding and would
      // bloat the row.
      const persisted: Components = {};
      for (const name of Object.keys(components) as SourceName[]) {
        const c = components[name];
        if (!c) continue;
        const { source, level, momentum, fetchedAt, meta } = c;
        persisted[name] = { source, level, momentum, fetchedAt, meta };
      }

      return { score: composite?.score ?? null, composite, components: persisted, seedSeries, fetched };
    })
  );
}

// Single-term convenience for the capture path: every source, fresh.
export async function composeVi(request: ScoreRequest, options: ScoreOptions = {}): Promise<SignalResult> {
  const [result] = await scoreTerms([request], 'all', options);
  return result;
}
