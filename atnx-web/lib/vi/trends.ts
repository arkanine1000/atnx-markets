// Google Trends as a VI source, anchored to a benchmark keyword.
//
// Trends rescales every query so the term's own weekly peak is 100, which
// makes single-term scores incomparable across markets ("Cat" and "The"
// outscored "Taylor Swift"). Co-querying up to four terms with one fixed
// benchmark puts them all on the benchmark's axis: a term at 2x the
// benchmark is twice as searched as one at 1x, whatever the market.
//
// Requests batch four markets at a time, which also quarters the call
// volume against an unofficial, rate-limited endpoint.
import googleTrends from 'google-trends-api';
import { clamp, ratioToBaseline, type SourceComponent } from './score';

// A steady, mid-volume query. Everyday hobby searches barely move week to
// week, which is what an anchor needs. Override per deployment if it drifts.
export const BENCHMARK = process.env.VI_TRENDS_BENCHMARK ?? 'sudoku';
const BATCH = 4;
const CACHE_TTL = 5 * 60 * 1000;
const WINDOW_DAYS = 7;
const MOMENTUM_MIN_RAW = 5;

export interface TrendsSignal extends SourceComponent {
  // Term/benchmark ratio per day, on the VI axis, for seeding a sparkline.
  series: { date: string; value: number }[];
}

const cache = new Map<string, { data: TrendsSignal; expiry: number }>();

// Term-to-benchmark ratio to level, log scale:
//   0.01x -> 100, 0.1x -> 300, 1x -> 500, 10x -> 700, 100x -> 900
// Trends reports integers, so anything under ~1% of the benchmark reads 0.
export function trendsLevel(ratio: number): number {
  if (ratio <= 0) return 0;
  return clamp(Math.round(500 + 200 * Math.log10(ratio)));
}

const empty = (): TrendsSignal => ({
  source: 'trends',
  level: null,
  momentum: null,
  fetchedAt: new Date().toISOString(),
  series: [],
});

// Below this mean benchmark reading the batch has lost precision: something
// in it is so much larger than the anchor that everything else rounds to 0.
const BENCH_MIN = 5;
// A term whose own peak reads at least this much is what squashed the batch.
const DOMINATOR_MIN = 20;
// Anchor floor for a lone dominator: peak 100 over 2.5 reads as ≥ 40x.
const BENCH_FLOOR = 2.5;

async function fetchBatch(terms: string[], depth = 0): Promise<Map<string, TrendsSignal>> {
  const out = new Map<string, TrendsSignal>();
  const keywords = [...terms, BENCHMARK];
  const raw = await googleTrends.interestOverTime({
    keyword: keywords,
    startTime: new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000),
    endTime: new Date(),
    granularTimeResolution: true,
  });
  const parsed = JSON.parse(raw) as {
    default?: { timelineData?: { time: string; value: number[] }[] };
  };
  const timeline = parsed.default?.timelineData ?? [];
  if (timeline.length === 0) return out;

  const benchIdx = keywords.length - 1;
  const benchValues = timeline.map((p) => p.value?.[benchIdx] ?? 0);
  let benchMean = benchValues.reduce((a, b) => a + b, 0) / benchValues.length;

  if (benchMean < BENCH_MIN) {
    // Split the batch: the dominators get re-queried alone, the rest as a
    // group without them. One level of recursion is enough; a single term
    // that still squashes the anchor is simply ≥ 20x it, scored as such.
    if (depth === 0) {
      const dominators = terms.filter((_, i) => Math.max(...timeline.map((p) => p.value?.[i] ?? 0)) >= DOMINATOR_MIN);
      const rest = terms.filter((t) => !dominators.includes(t));
      const parts = await Promise.all([
        rest.length ? fetchBatch(rest, 1) : Promise.resolve(new Map<string, TrendsSignal>()),
        ...dominators.map((t) => fetchBatch([t], 1)),
      ]);
      for (const part of parts) for (const [k, v] of part) out.set(k, v);
      return out;
    }
    if (terms.length > 1) return out;
    // Lone term, anchor still crushed: score against the anchor's floor.
    benchMean = Math.max(benchMean, BENCH_FLOOR);
  }

  terms.forEach((term, i) => {
    const values = timeline.map((p) => p.value?.[i] ?? 0);
    const ratios = values.map((v) => v / benchMean);
    const series = timeline.map((p, k) => ({
      date: new Date(parseInt(p.time, 10) * 1000).toISOString(),
      value: trendsLevel(ratios[k]),
    }));
    // The last point is today, partial. Level from the last two points
    // smooths that; momentum compares the latest full day to the rest.
    const lastTwo = ratios.slice(-2);
    const current = lastTwo.reduce((a, b) => a + b, 0) / lastTwo.length;
    const full = ratios.length >= 2 ? ratios.slice(0, -1) : ratios;
    const latestFull = full[full.length - 1];
    const prior = full.slice(0, -1);
    // Trends reports integers. A series of 0s and 1s is quantisation
    // noise, and a ratio of two such values means nothing.
    const quantised = Math.max(...values) < MOMENTUM_MIN_RAW;

    out.set(term, {
      source: 'trends',
      level: trendsLevel(current),
      momentum: quantised ? null : ratioToBaseline(latestFull, prior),
      fetchedAt: new Date().toISOString(),
      // A quantised series (raw 0s, 1s and 2s) is noise on the VI axis
      // too: it would seed a sparkline that swings between 0 and ~180.
      series: quantised ? [] : series,
      meta: {
        ratio_to_benchmark: Number(current.toFixed(3)),
        benchmark: BENCHMARK,
        keyword: term,
      },
    });
  });
  return out;
}

export interface TrendsQuery {
  term: string;
  aliases?: string[];
}

// Trends treats "a + b" as a OR b inside one keyword slot, so the name
// and its aliases cost one slot together. Keyword length is limited, so
// take aliases until the slot is full.
const MAX_KEYWORD = 100;
export function trendsKeyword({ term, aliases = [] }: TrendsQuery): string {
  let kw = term.trim();
  for (const a of aliases) {
    const alias = a.trim();
    if (!alias || alias.toLowerCase() === kw.toLowerCase()) continue;
    const next = `${kw} + ${alias}`;
    if (next.length > MAX_KEYWORD) break;
    kw = next;
  }
  return kw;
}

// Scores many terms with as few requests as possible. Results are keyed
// by the query's term. Terms that fail come back as "unknown" (null
// level) rather than being dropped.
export async function fetchTrendsSignals(queries: TrendsQuery[]): Promise<Map<string, TrendsSignal>> {
  const out = new Map<string, TrendsSignal>();
  const pending: { term: string; keyword: string }[] = [];
  for (const q of queries) {
    const keyword = trendsKeyword(q);
    const key = keyword.toLowerCase();
    const hit = cache.get(key);
    if (hit && Date.now() < hit.expiry) out.set(q.term, hit.data);
    else if (q.term.trim().length >= 2) pending.push({ term: q.term, keyword });
    else out.set(q.term, empty());
  }

  for (let i = 0; i < pending.length; i += BATCH) {
    const batch = pending.slice(i, i + BATCH);
    try {
      const got = await fetchBatch(batch.map((b) => b.keyword));
      for (const { term, keyword } of batch) {
        const sig = got.get(keyword) ?? empty();
        if (sig.level !== null) cache.set(keyword.toLowerCase(), { data: sig, expiry: Date.now() + CACHE_TTL });
        out.set(term, sig);
      }
    } catch (err) {
      console.error(`[trends] batch failed (${batch.map((b) => b.keyword).join(', ')}):`, err);
      for (const { term } of batch) out.set(term, empty());
    }
  }
  return out;
}

export async function fetchTrendsSignal(term: string, aliases: string[] = []): Promise<TrendsSignal> {
  const got = await fetchTrendsSignals([{ term, aliases }]);
  return got.get(term) ?? empty();
}

// Turns a market name into the phrase the sources search for: quotes
// stripped, title punctuation ("/", "|", ":") flattened to spaces. Every
// path that scores a market must use this, so the capture and the cron
// query the same string. The old version also cut long names to three
// words; with aliases carrying the short forms that only produced
// generic phrases ("Incidental 49A Real" for a five-word title).
export function normalizeSearchTerm(analysis: { name?: string } | null | undefined): string {
  let term = analysis?.name || '';
  term = term.replace(/["“”'‘’]/g, '');
  term = term.replace(/[\/|:;,\-–—•·_()\[\]]+/g, ' ');
  return term.replace(/\s+/g, ' ').trim();
}
