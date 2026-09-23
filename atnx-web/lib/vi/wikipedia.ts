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
  return (await resolveArticleTitles(term))[0] ?? null;
}

// Every OpenSearch candidate that is the term itself, in search order.
// With `corporate`, a company suffix is ignored too, so "Apple" also
// matches "Apple Inc." and "Meta" matches "Meta Platforms": the plain name
// is often a different article (the fruit) or a disambiguation page.
export async function resolveArticleTitles(term: string, { corporate = false } = {}): Promise<string[]> {
  const params = new URLSearchParams({
    action: 'opensearch',
    search: term,
    limit: '8',
    namespace: '0',
    format: 'json',
  });
  const res = await fetch(`${OPENSEARCH_URL}?${params}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) return [];
  const body = (await res.json()) as [string, string[], string[], string[]];
  return (body?.[1] ?? []).filter((title) => titleMatchesTerm(term, title, { corporate }));
}

// Whether an article title is the term itself: case, punctuation and a
// disambiguation suffix aside, and with `corporate` a company suffix too.
export function titleMatchesTerm(term: string, title: string, { corporate = false } = {}): boolean {
  let bare = title.replace(/\s*\([^)]*\)\s*$/, '');
  if (corporate) {
    for (let i = 0; i < 3; i++) bare = bare.replace(CORPORATE_SUFFIX, '');
  }
  return normalizeTitle(bare) === normalizeTitle(term);
}

const CORPORATE_SUFFIX =
  /[,.]?\s+(inc\.?|incorporated|corporation|corp\.?|company|co\.?|ltd\.?|limited|llc|plc|ag|sa|se|nv|gmbh|group|holdings?|platforms|technologies|technology|labs|international|global|entertainment|media|studios?|games|motors|systems|software|networks?|interactive)$/i;

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
//
// Redirects are not followed here or below: a title that redirects
// ("Kirkiversary" into "Assassination of Charlie Kirk") is a section of a
// broader subject, whose picture is not the title's.
export async function fetchWikipediaPageImage(title: string, width = 1024): Promise<WikipediaPageImage | null> {
  const params = new URLSearchParams({
    action: 'query',
    prop: 'pageimages',
    piprop: 'thumbnail|name',
    pithumbsize: String(width),
    pilicense: 'any',
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

export interface ArticleFacts {
  title: string;
  // The article's Wikidata item, when it has one.
  qid: string | null;
  // Wikipedia's one-line description ("American technology company",
  // "Internet meme", "Given name"), the cheapest way to tell what kind of
  // thing an article is about.
  shortDescription: string | null;
  disambiguation: boolean;
}

// What kind of page a title is, from its page properties. Null when there
// is no such page. Redirects are not followed (see fetchWikipediaPageImage).
export async function fetchArticleFacts(title: string): Promise<ArticleFacts | null> {
  const props = new URLSearchParams({
    action: 'query',
    prop: 'pageprops',
    ppprop: 'wikibase_item|wikibase-shortdesc|disambiguation',
    titles: title,
    format: 'json',
    formatversion: '2',
  });
  const res = await fetch(`${OPENSEARCH_URL}?${props}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`pageprops ${res.status}`);
  const body = (await res.json()) as {
    query?: {
      pages?: {
        title: string;
        missing?: boolean;
        pageprops?: { wikibase_item?: string; 'wikibase-shortdesc'?: string; disambiguation?: string };
      }[];
    };
  };
  const page = body.query?.pages?.[0];
  if (!page || page.missing) return null;
  return {
    title: page.title,
    qid: page.pageprops?.wikibase_item ?? null,
    shortDescription: page.pageprops?.['wikibase-shortdesc'] ?? null,
    disambiguation: page.pageprops?.disambiguation !== undefined,
  };
}

// The values of one property on a Wikidata item, best rank first: item
// ids for item-valued properties (P31 "instance of"), file names for
// Commons media (P154 "logo image").
export async function fetchWikidataValues(qid: string, property: string): Promise<string[]> {
  const params = new URLSearchParams({ action: 'wbgetclaims', entity: qid, property, format: 'json' });
  const res = await fetch(`${WIKIDATA_URL}?${params}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`wbgetclaims ${res.status}`);
  const body = (await res.json()) as {
    claims?: Record<
      string,
      { rank?: string; mainsnak?: { datavalue?: { value?: string | { id?: string } } } }[]
    >;
  };
  const claims = (body.claims?.[property] ?? []).filter((c) => c.rank !== 'deprecated');
  claims.sort((a, b) => (b.rank === 'preferred' ? 1 : 0) - (a.rank === 'preferred' ? 1 : 0));
  const values: string[] = [];
  for (const c of claims) {
    const v = c.mainsnak?.datavalue?.value;
    if (typeof v === 'string') values.push(v);
    else if (v?.id) values.push(v.id);
  }
  return values;
}

// The Wikidata item for a human being (P31 "instance of").
export const WIKIDATA_HUMAN = 'Q5';

// The item's logo (P154 "logo image"), rendered by Commons as a raster at
// most `width` wide. Null when the item has no logo.
export async function fetchWikidataLogo(qid: string, width = 1024): Promise<WikipediaPageImage | null> {
  const [file] = await fetchWikidataValues(qid, 'P154');
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
