// Wikipedia pageviews as a virality signal. No auth required; the Wikimedia
// REST APIs only ask for a descriptive User-Agent. We do two calls:
//   1. OpenSearch to resolve a free-text query to a canonical article title
//      (handles capitalization, redirects, disambiguation).
//   2. Per-article-daily pageviews for the last ~30 days.
// The pageviews API lags ~24h, so we end the window 2 days back.
const USER_AGENT = 'ATNX/1.0 (attention-exchange; contact@atnx.app)';
const OPENSEARCH_URL = 'https://en.wikipedia.org/w/api.php';
const PAGEVIEWS_BASE =
  'https://wikimedia.org/api/rest_v1/metrics/pageviews/per-article/en.wikipedia/all-access/user';

const cache = new Map<string, { data: WikipediaResult; expiry: number }>();
const CACHE_TTL = 60 * 60 * 1000; // 1 hour — pageviews only update daily.

export interface WikipediaResult {
  title: string | null;
  peakDailyViews: number;
  totalViews: number;
  dailyViews: { date: string; views: number }[];
  score: number;
  fetchedAt: string;
}

export async function fetchWikipediaSignal(
  searchTerm: string
): Promise<WikipediaResult> {
  const key = searchTerm.toLowerCase().trim();
  const cached = cache.get(key);
  if (cached && Date.now() < cached.expiry) return cached.data;

  const empty: WikipediaResult = {
    title: null,
    peakDailyViews: 0,
    totalViews: 0,
    dailyViews: [],
    score: 0,
    fetchedAt: new Date().toISOString(),
  };

  if (!searchTerm || searchTerm.length < 2) return empty;

  try {
    const title = await resolveArticleTitle(searchTerm);
    if (!title) {
      cache.set(key, { data: empty, expiry: Date.now() + CACHE_TTL });
      return empty;
    }

    const daily = await fetchDailyPageviews(title);
    const peakDailyViews = daily.reduce(
      (max, d) => (d.views > max ? d.views : max),
      0
    );
    const totalViews = daily.reduce((sum, d) => sum + d.views, 0);

    const result: WikipediaResult = {
      title,
      peakDailyViews,
      totalViews,
      dailyViews: daily,
      score: wikipediaScore(peakDailyViews),
      fetchedAt: new Date().toISOString(),
    };

    cache.set(key, { data: result, expiry: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.error(`[wikipedia] query failed for "${searchTerm}":`, err);
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

  // OpenSearch returns [query, titles[], descriptions[], urls[]].
  const body = (await res.json()) as [string, string[], string[], string[]];
  const first = body?.[1]?.[0];
  return first ?? null;
}

async function fetchDailyPageviews(
  title: string
): Promise<{ date: string; views: number }[]> {
  // Pageviews lag ~24h. End window 2 days back, pull 30 days prior.
  const end = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - 30 * 24 * 60 * 60 * 1000);

  const url = `${PAGEVIEWS_BASE}/${encodeURIComponent(
    title.replace(/ /g, '_')
  )}/daily/${formatDate(start)}/${formatDate(end)}`;

  const res = await fetch(url, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) return [];

  const body = (await res.json()) as {
    items?: { timestamp: string; views: number }[];
  };
  return (body.items ?? []).map((item) => ({
    // timestamp is YYYYMMDDHH, always 00 for daily.
    date: `${item.timestamp.slice(0, 4)}-${item.timestamp.slice(
      4,
      6
    )}-${item.timestamp.slice(6, 8)}`,
    views: item.views,
  }));
}

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}

// Maps peak daily pageviews to a 0-1000 VI component.
//   0 views     → 0
//   ~90/day     → 200
//   ~1k/day     → 400
//   ~10k/day    → 600
//   ~100k/day   → 800
//   ~1M+/day    → 1000
export function wikipediaScore(peakDailyViews: number): number {
  if (peakDailyViews <= 0) return 0;
  const raw = Math.log10(peakDailyViews + 10) * 200 - 200;
  return Math.max(0, Math.min(1000, Math.round(raw)));
}
