// Wikipedia pageviews as a VI source. No auth; the Wikimedia REST APIs ask
// only for a descriptive User-Agent. Two calls:
//   1. OpenSearch to resolve free text to a canonical article title.
//   2. Per-article daily pageviews for the last ~30 days.
// Daily data with a ~1-2 day lag, so the slow refresh path owns this.
// Level comes from the latest available day, not the 30-day peak, so a
// market can fall again once its moment passes.
import { clamp, median, ratioToBaseline, type SourceComponent } from './score';

const USER_AGENT = 'ATNX/1.0 (attention-exchange; contact@atnx.app)';
const OPENSEARCH_URL = 'https://en.wikipedia.org/w/api.php';
const PAGEVIEWS_BASE =
  'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user';
const CACHE_TTL = 60 * 60 * 1000;

export interface WikipediaSignal extends SourceComponent {
  title: string | null;
}

const cache = new Map<string, { data: WikipediaSignal; expiry: number }>();

// Daily views to level, log scale:
//   ~90/day -> 200, 1k -> 400, 10k -> 600, 100k -> 800, 1M+ -> 1000
export function wikipediaLevel(dailyViews: number): number {
  if (dailyViews <= 0) return 0;
  return clamp(Math.round(Math.log10(dailyViews + 10) * 200 - 200));
}

export async function fetchWikipediaSignal(term: string, aliases: string[] = []): Promise<WikipediaSignal> {
  const key = [term, ...aliases].join('|').toLowerCase().trim();
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiry) return hit.data;

  const empty: WikipediaSignal = {
    source: 'wikipedia',
    title: null,
    level: null,
    momentum: null,
    fetchedAt: new Date().toISOString(),
  };
  if (term.trim().length < 2) return empty;

  try {
    // The name first; an alias only when the name resolves to nothing.
    let title = await resolveArticleTitle(term);
    for (const alias of aliases) {
      if (title || alias.trim().length < 2) break;
      title = await resolveArticleTitle(alias);
    }
    if (!title) {
      // No article is a real observation: Wikipedia has nothing on it.
      const none: WikipediaSignal = { ...empty, level: 0 };
      cache.set(key, { data: none, expiry: Date.now() + CACHE_TTL });
      return none;
    }

    const daily = await fetchDailyPageviews(title);
    if (daily.length === 0) {
      const none: WikipediaSignal = { ...empty, title, level: 0 };
      cache.set(key, { data: none, expiry: Date.now() + CACHE_TTL });
      return none;
    }

    const views = daily.map((d) => d.views);
    const latest = views[views.length - 1];
    const prior = views.slice(0, -1).slice(-14);
    // Median baseline so one earlier spike does not hide a new one.
    const base = median(prior);
    const momentum = prior.length === 0 ? null : base > 0 ? latest / base : ratioToBaseline(latest, prior);

    const result: WikipediaSignal = {
      source: 'wikipedia',
      title,
      level: wikipediaLevel(latest),
      momentum,
      fetchedAt: new Date().toISOString(),
      meta: {
        title,
        views_latest: latest,
        views_median_14d: base,
        latest_date: daily[daily.length - 1].date,
      },
    };
    cache.set(key, { data: result, expiry: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.error(`[wikipedia] query failed for "${term}":`, err);
    return empty;
  }
}

async function resolveArticleTitle(term: string): Promise<string | null> {
  const params = new URLSearchParams({
    action: 'opensearch',
    search: term,
    limit: '1',
    namespace: '0',
    format: 'json',
  });
  const res = await fetch(`${OPENSEARCH_URL}?${params}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as [string, string[], string[], string[]];
  return body?.[1]?.[0] ?? null;
}

async function fetchDailyPageviews(title: string): Promise<{ date: string; views: number }[]> {
  // Pageviews lag ~24h. End the window 2 days back, pull 30 days prior.
  const end = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);
  const url = `${PAGEVIEWS_BASE}/${encodeURIComponent(title.replace(/ /g, '_'))}/daily/${formatDate(start)}/${formatDate(end)}`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' } });
  if (!res.ok) return [];
  const body = (await res.json()) as { items?: { timestamp: string; views: number }[] };
  return (body.items ?? []).map((item) => ({
    date: `${item.timestamp.slice(0, 4)}-${item.timestamp.slice(4, 6)}-${item.timestamp.slice(6, 8)}`,
    views: item.views,
  }));
}

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
