// Hacker News via the Algolia search API as a VI source. Free, no auth,
// and unlike the other free sources it returns an absolute count
// (`nbHits`) for an arbitrary phrase over any time window, with the full
// archive behind it for a baseline. It only sees the tech and crypto
// conversation, so the dispatcher asks it about those categories alone;
// for anything else it is unknown, not zero.
//
// Two calls per market: stories and comments mentioning the phrase in
// the last 24 hours, and in the last 7 days. The slow path owns it.
import { clamp, ratioToBaseline, type SourceComponent } from './score';

const API = 'https://hn.algolia.com/api/v1/search_by_date';
const USER_AGENT = 'ATNX/1.0 (attention-exchange; contact@atnx.app)';
const CACHE_TTL = 50 * 60 * 1000;
const DAY_S = 24 * 3600;
// Below this many hits in the prior six days the daily rate is noise.
const MOMENTUM_MIN_PRIOR = 6;

const cache = new Map<string, { data: SourceComponent; expiry: number }>();

// Hits in 24h to level, log scale, same axis as Bluesky posts:
//   0 -> 0, 1 -> 100, 10 -> 300, 100 -> 500, 1k -> 700
export function hnLevel(hits24h: number): number {
  if (hits24h <= 0) return 0;
  return clamp(Math.round(100 + 200 * Math.log10(hits24h)));
}

async function countSince(phrase: string, sinceS: number): Promise<number | null> {
  const params = new URLSearchParams({
    query: `"${phrase.replace(/"/g, '')}"`,
    tags: '(story,comment)',
    numericFilters: `created_at_i>${sinceS}`,
    hitsPerPage: '0',
  });
  const res = await fetch(`${API}?${params}`, { headers: { 'User-Agent': USER_AGENT }, cache: 'no-store' });
  if (!res.ok) {
    console.error(`[hn] ${res.status} for "${phrase}"`);
    return null;
  }
  const body = (await res.json()) as { nbHits?: number };
  return typeof body.nbHits === 'number' ? body.nbHits : null;
}

export async function fetchHnSignal(term: string): Promise<SourceComponent> {
  const phrase = term.trim();
  const key = phrase.toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiry) return hit.data;

  const empty: SourceComponent = { source: 'hn', level: null, momentum: null, fetchedAt: new Date().toISOString() };
  if (phrase.length < 2) return empty;

  try {
    const nowS = Math.floor(Date.now() / 1000);
    const [day, week] = await Promise.all([countSince(phrase, nowS - DAY_S), countSince(phrase, nowS - 7 * DAY_S)]);
    if (day === null || week === null) return empty;
    const priorPerDay = Math.max(0, week - day) / 6;
    const momentum = week - day < MOMENTUM_MIN_PRIOR ? null : ratioToBaseline(day, [priorPerDay]);
    const result: SourceComponent = {
      source: 'hn',
      level: hnLevel(day),
      momentum,
      fetchedAt: new Date().toISOString(),
      meta: { hits_24h: day, hits_7d: week },
    };
    cache.set(key, { data: result, expiry: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.error(`[hn] query failed for "${term}":`, err);
    return empty;
  }
}
