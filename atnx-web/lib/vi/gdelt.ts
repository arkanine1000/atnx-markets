// GDELT DOC 2.0 news volume as a VI source. Free, no auth, but strict: one
// request per 5 seconds per IP, 429 otherwise, and daily resolution past
// 72 hours. Calls are serialised through a module-level queue and cached
// for an hour; the slow refresh path owns this source.
import { clamp, ratioToBaseline, type SourceComponent } from './score';

const API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const MIN_GAP_MS = 5_200;
const CACHE_TTL = 60 * 60 * 1000;
const USER_AGENT = 'ATNX/1.0 (attention-exchange; contact@atnx.app)';

const cache = new Map<string, { data: SourceComponent; expiry: number }>();

// Serialise requests so a batch never trips the per-IP limit.
let chain: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;
function scheduled<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const wait = lastCallAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  chain = run.catch(() => undefined);
  return run;
}

// timelinevol returns the share (%) of all monitored articles that match
// the query, per day for a 7-day span. Maps to level on a log scale:
//   0.0001% -> 0, 0.001% -> 250, 0.01% -> 500, 0.1% -> 750, 1%+ -> 1000
export function gdeltLevel(meanPct: number): number {
  if (meanPct <= 0) return 0;
  return clamp(Math.round(((Math.log10(meanPct) + 4) / 4) * 1000));
}

const MAX_PHRASES = 4;

export async function fetchGdeltSignal(term: string, aliases: string[] = []): Promise<SourceComponent> {
  // The name and up to three aliases as one OR query; GDELT counts an
  // article once however many phrases it matches.
  const phrases = [term, ...aliases]
    .map((p) => p.trim().replace(/"/g, ''))
    .filter((p, i, all) => p.length >= 2 && all.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i)
    .slice(0, MAX_PHRASES);
  const key = phrases.join('|').toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiry) return hit.data;

  const empty: SourceComponent = {
    source: 'gdelt',
    level: null,
    momentum: null,
    fetchedAt: new Date().toISOString(),
  };
  if (phrases.length === 0) return empty;

  const quoted = phrases.map((p) => `"${p}"`);
  const params = new URLSearchParams({
    query: quoted.length === 1 ? quoted[0] : `(${quoted.join(' OR ')})`,
    mode: 'timelinevol',
    timespan: '7d',
    format: 'json',
  });

  try {
    const res = await scheduled(() =>
      fetch(`${API}?${params}`, { headers: { 'User-Agent': USER_AGENT }, cache: 'no-store' })
    );
    if (!res.ok) {
      // 429 is the only common failure; do not cache it, retry next pass.
      console.error(`[gdelt] ${res.status} for "${term}"`);
      return empty;
    }
    const text = await res.text();
    // GDELT answers "{}" for no matches, an empty body when overloaded, and
    // a plain-text sentence for queries it will not run (too short, etc).
    if (text.trim() && !text.trim().startsWith('{')) {
      console.error(`[gdelt] refused "${term}": ${text.trim().slice(0, 80)}`);
      return empty;
    }
    if (!text.trim() || text.trim() === '{}') {
      const none: SourceComponent = { ...empty, level: 0, meta: { articles_pct_7d: 0 } };
      cache.set(key, { data: none, expiry: Date.now() + CACHE_TTL });
      return none;
    }
    const body = JSON.parse(text) as { timeline?: { data?: { date: string; value: number }[] }[] };
    const points = (body.timeline?.[0]?.data ?? []).map((p) => p.value);
    if (points.length === 0) return empty;

    // The last point is the partial current day; the one before it is the
    // latest full day.
    const full = points.length >= 2 ? points.slice(0, -1) : points;
    const latest = full[full.length - 1];
    const prior = full.slice(0, -1);
    const mean = full.reduce((a, b) => a + b, 0) / full.length;

    const result: SourceComponent = {
      source: 'gdelt',
      level: gdeltLevel(mean),
      momentum: ratioToBaseline(latest, prior),
      fetchedAt: new Date().toISOString(),
      meta: { articles_pct_7d: Number(mean.toFixed(4)), articles_pct_latest: Number(latest.toFixed(4)) },
    };
    cache.set(key, { data: result, expiry: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.error(`[gdelt] query failed for "${term}":`, err);
    return empty;
  }
}
