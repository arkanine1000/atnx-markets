// Composite VI dispatcher. Four sources, each reporting an absolute level
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
  type SourceName,
} from './vi/score';
import { fetchTrendsSignals, type TrendsSignal } from './vi/trends';
import { fetchBlueskySignal } from './vi/bluesky';
import { fetchGdeltSignal } from './vi/gdelt';
import { fetchWikipediaSignal } from './vi/wikipedia';

export interface ScoreRequest {
  term: string;
  // Other names people use for it (markets.aliases). Sources search for
  // the name and its aliases together; a canonical meme title is rarely
  // what a post actually says.
  aliases?: string[];
  // Breakdown stored on the market from earlier passes, if any.
  stored?: Components | null;
}

export interface SignalResult {
  // Null when no source has data. Callers keep the last known value.
  score: number | null;
  composite: Composite | null;
  components: Components;
  // Trends series on the VI axis, for seeding a new market's sparkline.
  seedSeries: { date: string; value: number }[];
}

export type Cadence = 'fast' | 'slow' | 'all';

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

// Scores many terms at once so Trends can batch them.
export async function scoreTerms(requests: ScoreRequest[], cadence: Cadence): Promise<SignalResult[]> {
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

      const [bluesky, gdelt, wikipedia] = await Promise.all([
        want.has('bluesky') ? fetchBlueskySignal(term, aliases).catch(() => null) : null,
        want.has('gdelt') ? fetchGdeltSignal(term, aliases).catch(() => null) : null,
        want.has('wikipedia') ? fetchWikipediaSignal(term, aliases).catch(() => null) : null,
      ]);
      if (bluesky) components.bluesky = bluesky;
      if (gdelt) components.gdelt = gdelt;
      if (wikipedia) components.wikipedia = wikipedia;

      // A source that answered "unknown" this pass must not erase a real
      // earlier reading; keep the stored one.
      for (const name of Object.keys(components) as SourceName[]) {
        const c = components[name];
        if (c && c.level === null && stored?.[name]?.level != null) components[name] = stored[name];
      }

      // Single common words score big on search and social by accident.
      // Only count those sources when Wikipedia knows the term by that name.
      const wikiTitle = (components.wikipedia?.meta?.title as string | undefined) ?? null;
      if (isGenericTerm(term, wikiTitle)) {
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

      return { score: composite?.score ?? null, composite, components: persisted, seedSeries };
    })
  );
}

// Single-term convenience for the capture path: every source, fresh.
export async function composeVi({ term, aliases = [] }: { term: string; aliases?: string[] }): Promise<SignalResult> {
  const [result] = await scoreTerms([{ term, aliases }], 'all');
  return result;
}
