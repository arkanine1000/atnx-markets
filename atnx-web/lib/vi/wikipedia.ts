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

// OpenSearch is a prefix/fuzzy search: "ATNX" returns "ATX", "Goonmobile"
// returns "GEO-Mobile Radio Interface". Only a title that is the term
// itself (case, punctuation and a disambiguation suffix aside) counts as
// the term's article; anything else is a different subject's pageviews.
export async function resolveArticleTitle(term: string): Promise<string | null> {
  const params = new URLSearchParams({
    action: 'opensearch',
    search: term,
    limit: '5',
    namespace: '0',
    format: 'json',
  });
  const res = await fetch(`${OPENSEARCH_URL}?${params}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) return null;
  const body = (await res.json()) as [string, string[], string[], string[]];
  const want = normalizeTitle(term);
  for (const title of body?.[1] ?? []) {
    const got = normalizeTitle(title.replace(/\s*\([^)]*\)\s*$/, ''));
    if (got === want) return title;
  }
  return null;
}

// Whether an article title is the term itself, by the same rule as
// resolveArticleTitle: case, punctuation and a disambiguation suffix aside.
export function titleMatchesTerm(term: string, title: string): boolean {
  return normalizeTitle(title.replace(/\s*\([^)]*\)\s*$/, '')) === normalizeTitle(term);
}

function normalizeTitle(s: string): string {
  return s
    .toLowerCase()
    .replace(/[‘’'"“”]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
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

export interface WikipediaPageImage {
  url: string;
  width: number;
  height: number;
  file: string;
}

// The article's lead image (MediaWiki's PageImages pick), rendered as a
// raster at most `width` wide, so an SVG logo comes back as a PNG. Non-free
// images are included: a company's logo on that company's market is the
// point. Null when the article has no usable image.
export async function fetchWikipediaPageImage(title: string, width = 1024): Promise<WikipediaPageImage | null> {
  const params = new URLSearchParams({
    action: 'query',
    prop: 'pageimages',
    piprop: 'thumbnail|name',
    pithumbsize: String(width),
    pilicense: 'any',
    redirects: '1',
    titles: title,
    format: 'json',
    formatversion: '2',
  });
  const res = await fetch(`${OPENSEARCH_URL}?${params}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`pageimages ${res.status}`);
  const body = (await res.json()) as {
    query?: { pages?: { thumbnail?: { source: string; width: number; height: number }; pageimage?: string }[] };
  };
  const page = body.query?.pages?.[0];
  if (!page?.thumbnail?.source || !page.pageimage) return null;
  return {
    url: page.thumbnail.source,
    width: page.thumbnail.width,
    height: page.thumbnail.height,
    file: page.pageimage,
  };
}

const WIKIDATA_URL = 'https://www.wikidata.org/w/api.php';
const COMMONS_FILE_URL = 'https://commons.wikimedia.org/wiki/Special:FilePath/';

// The entity's logo from Wikidata (property P154, "logo image"), reached
// through the article's Wikidata item. Rendered by Commons as a raster at
// most `width` wide. Null when the article has no item or the item has
// no logo.
export async function fetchWikidataLogo(title: string, width = 1024): Promise<WikipediaPageImage | null> {
  const props = new URLSearchParams({
    action: 'query',
    prop: 'pageprops',
    ppprop: 'wikibase_item',
    redirects: '1',
    titles: title,
    format: 'json',
    formatversion: '2',
  });
  const pageRes = await fetch(`${OPENSEARCH_URL}?${props}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!pageRes.ok) throw new Error(`pageprops ${pageRes.status}`);
  const pageBody = (await pageRes.json()) as { query?: { pages?: { pageprops?: { wikibase_item?: string } }[] } };
  const qid = pageBody.query?.pages?.[0]?.pageprops?.wikibase_item;
  if (!qid) return null;

  const claims = new URLSearchParams({ action: 'wbgetclaims', entity: qid, property: 'P154', format: 'json' });
  const claimRes = await fetch(`${WIKIDATA_URL}?${claims}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!claimRes.ok) throw new Error(`wbgetclaims ${claimRes.status}`);
  const claimBody = (await claimRes.json()) as {
    claims?: { P154?: { rank?: string; mainsnak?: { datavalue?: { value?: string } } }[] };
  };
  const logos = claimBody.claims?.P154 ?? [];
  // A preferred-rank statement is the current logo; otherwise the first.
  const pick = logos.find((c) => c.rank === 'preferred') ?? logos[0];
  const file = pick?.mainsnak?.datavalue?.value;
  if (!file) return null;
  return {
    url: `${COMMONS_FILE_URL}${encodeURIComponent(file)}?width=${width}`,
    width,
    height: 0,
    file,
  };
}

export { USER_AGENT as WIKIMEDIA_USER_AGENT };

function formatDate(d: Date): string {
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}${m}${day}`;
}
