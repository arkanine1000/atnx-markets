// Wikipedia pageviews as a VI source. No auth; the Wikimedia REST APIs ask
// only for a descriptive User-Agent. Two calls:
//   1. OpenSearch to resolve free text to a canonical article title.
//   2. Per-article daily pageviews for the last ~30 days.
// Daily data with a ~1-2 day lag, so the slow refresh path owns this.
// Level comes from the latest available day, not the 30-day peak, so a
// market can fall again once its moment passes.
import { clamp, median, type SourceComponent } from './score';

// Momentum needs this many pageviews a day (14-day median) to mean anything.
const MIN_MOMENTUM_VIEWS = 10;

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

export interface WikipediaOptions {
  // Accept a company-suffixed article ("Meta Platforms" for "Meta"). On
  // for brand markets only: for anything else the plain name is the
  // subject or nothing is.
  corporate?: boolean;
  // One-word aliases to vouch for: those that redirect to the market's
  // own article are written to meta.alias_ok, and the other sources may
  // then search for them (lib/vi/score.ts searchableAliases).
  aliasCandidates?: string[];
}

export async function fetchWikipediaSignal(
  term: string,
  aliases: string[] = [],
  { corporate = false, aliasCandidates = [] }: WikipediaOptions = {}
): Promise<WikipediaSignal> {
  const key = [corporate ? 'c' : 'p', term, ...aliases, '#', ...aliasCandidates].join('|').toLowerCase().trim();
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
    let from: 'term' | 'alias' = 'term';
    let resolved = await resolvePageviewArticle(term, { corporate });
    for (const alias of aliases) {
      if (resolved.title || alias.trim().length < 2) break;
      const viaAlias = await resolvePageviewArticle(alias, { corporate });
      if (viaAlias.title) {
        from = 'alias';
        resolved = { ...viaAlias, ambiguous: resolved.ambiguous, namedRedirect: resolved.namedRedirect, redirectTitle: resolved.redirectTitle };
      }
    }
    // Whether the article (or the absence of one) is the term's own
    // subject, for the generic-term guard: a proper noun that Wikipedia
    // knows by that name, even as a redirect into a broader article, is
    // not a common word; a disambiguation page or an alias's article says
    // nothing about the name itself.
    const own =
      from === 'term' &&
      (resolved.match === 'exact' ||
        resolved.match === 'corporate' ||
        resolved.match === 'redirect' ||
        (resolved.match === 'qualified' && !resolved.ambiguous) ||
        resolved.namedRedirect)
        ? 1
        : 0;
    // No article of its own, but the name redirects into a section of one:
    // score the redirect title's own pageviews (see redirectTitle).
    const sectionRedirect = !resolved.title && from === 'term' && resolved.namedRedirect && !!resolved.redirectTitle;
    const title = resolved.title ?? (sectionRedirect ? resolved.redirectTitle : null);
    // One-word aliases that are this article under another name.
    const alias_ok = title && own === 1 ? (await verifiedAliases(title, aliasCandidates)).join(',') : '';
    const base = { match: sectionRedirect ? ('section_redirect' as const) : resolved.match, from, own, alias_ok };

    if (!title) {
      // No article is a real observation: Wikipedia has nothing on it.
      const none: WikipediaSignal = { ...empty, level: 0, meta: { title: null, ...base } };
      cache.set(key, { data: none, expiry: Date.now() + CACHE_TTL });
      return none;
    }

    const daily = await fetchDailyPageviews(title);
    if (daily.length === 0) {
      const none: WikipediaSignal = { ...empty, title, level: 0, meta: { title, ...base } };
      cache.set(key, { data: none, expiry: Date.now() + CACHE_TTL });
      return none;
    }

    const views = daily.map((d) => d.views);
    const latest = views[views.length - 1];
    const prior = views.slice(0, -1).slice(-14);
    // Median baseline so one earlier spike does not hide a new one.
    const median14 = median(prior);
    // Under MIN_MOMENTUM_VIEWS a day the ratio is a count, not a trend:
    // a namesake page at 2 views against a median of 0.5 read 4.0x.
    const momentum = prior.length === 0 || median14 < MIN_MOMENTUM_VIEWS ? null : latest / median14;

    const result: WikipediaSignal = {
      source: 'wikipedia',
      title,
      level: wikipediaLevel(latest),
      momentum,
      fetchedAt: new Date().toISOString(),
      meta: {
        title,
        views_latest: latest,
        views_median_14d: median14,
        latest_date: daily[daily.length - 1].date,
        ...base,
      },
    };
    cache.set(key, { data: result, expiry: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.error(`[wikipedia] query failed for "${term}":`, err);
    return empty;
  }
}

// The candidates that are the article itself under another name: they
// resolve, without a fragment, to the very title, and are not a
// disambiguation page or the title spelled differently. "Trump" passes for
// Donald Trump; "Musk" (the substance) and "Elon" (a disambiguation page)
// do not. Pure.
export function verifyAliases(title: string, candidates: string[], pages: Map<string, PageInfo>): string[] {
  const own = title.trim().toLowerCase();
  return candidates.filter((c) => {
    const info = pages.get(c);
    if (!info || info.missing || info.disambiguation || info.fragment) return false;
    if (info.title !== title) return false;
    return c.trim().toLowerCase() !== own;
  });
}

async function verifiedAliases(title: string, candidates: string[]): Promise<string[]> {
  const wanted = [...new Set(candidates.map((c) => c.trim()).filter((c) => c.length >= 2))];
  if (wanted.length === 0) return [];
  try {
    return verifyAliases(title, wanted, await lookupPages(wanted));
  } catch (err) {
    console.error(`[wikipedia] alias lookup failed for "${title}": ${(err as Error).message}`);
    return [];
  }
}

// What a requested title turns out to be once MediaWiki has normalised it
// and followed any redirect.
export interface PageInfo {
  requested: string;
  // The requested title as MediaWiki normalised it, before any redirect.
  source: string;
  // The article actually reached (the redirect target when redirected).
  title: string;
  // Set when the redirect points into a section: the term is a part of
  // a broader subject, not an article of its own.
  fragment: string | null;
  redirected: boolean;
  missing: boolean;
  disambiguation: boolean;
}

// One query for many titles: normalisation, redirects and whether each
// page is a disambiguation page. Keyed by the requested title.
export async function lookupPages(titles: string[]): Promise<Map<string, PageInfo>> {
  const out = new Map<string, PageInfo>();
  const wanted = [...new Set(titles.filter((t) => t.trim()))].slice(0, 50);
  if (wanted.length === 0) return out;
  const params = new URLSearchParams({
    action: 'query',
    titles: wanted.join('|'),
    redirects: '1',
    prop: 'pageprops',
    ppprop: 'disambiguation',
    format: 'json',
    formatversion: '2',
  });
  const res = await fetch(`${OPENSEARCH_URL}?${params}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (!res.ok) throw new Error(`query ${res.status}`);
  const body = (await res.json()) as {
    query?: {
      normalized?: { from: string; to: string }[];
      redirects?: { from: string; to: string; tofragment?: string }[];
      pages?: { title: string; missing?: boolean; pageprops?: { disambiguation?: string } }[];
    };
  };
  const normalized = new Map((body.query?.normalized ?? []).map((n) => [n.from, n.to]));
  const redirects = new Map((body.query?.redirects ?? []).map((r) => [r.from, r]));
  const pages = new Map((body.query?.pages ?? []).map((p) => [p.title, p]));
  for (const requested of wanted) {
    let title = normalized.get(requested) ?? requested;
    let redirected = false;
    let fragment: string | null = null;
    // Redirect chains are rare but MediaWiki reports each hop.
    for (let hop = 0; hop < 3; hop++) {
      const r = redirects.get(title);
      if (!r) break;
      redirected = true;
      title = r.to;
      fragment = r.tofragment ?? fragment;
    }
    const page = pages.get(title);
    out.set(requested, {
      requested,
      source: normalized.get(requested) ?? requested,
      title,
      fragment,
      redirected,
      missing: !page || !!page.missing,
      disambiguation: page?.pageprops?.disambiguation !== undefined,
    });
  }
  return out;
}

export type ArticleMatch = 'exact' | 'qualified' | 'corporate' | 'redirect' | 'section_redirect';

export interface CandidateVerdict {
  // The article whose pageviews stand for the term, or null.
  title: string | null;
  match: ArticleMatch | null;
  // The term's own title is a disambiguation page: the name means
  // several things, and search and social counts of it are not ours.
  ambiguous: boolean;
  // The term's own title redirects into a section of a broader article:
  // a name Wikipedia knows, whose subject is a part of another one.
  namedRedirect: boolean;
  // That redirect's own title ("Big Chungus"). Its pageviews are the
  // people who looked up the name itself: the pageviews API does not
  // follow redirects, so they are counted apart from the target article's
  // (the 1941 cartoon's). PR #20 assumed a section redirect had no
  // pageviews and scored it 0; Big Chungus had 368 in a week.
  redirectTitle: string | null;
}

const none = (): CandidateVerdict => ({ title: null, match: null, ambiguous: false, namedRedirect: false, redirectTitle: null });

// Whether a looked-up candidate is the term's article. Pure.
export function judgeCandidate(term: string, info: PageInfo, { corporate = false } = {}): CandidateVerdict {
  const bare = normalizeTitle(info.requested) === normalizeTitle(term);
  if (info.missing) return none();
  if (info.disambiguation) return { ...none(), ambiguous: bare };
  if (!info.redirected) {
    const match: ArticleMatch | null = bare
      ? 'exact'
      : titleMatchesTerm(term, info.title)
        ? 'qualified'
        : corporate && titleMatchesTerm(term, info.title, { corporate: true })
          ? 'corporate'
          : null;
    return match ? { ...none(), title: info.title, match } : none();
  }
  if (info.fragment) return { ...none(), namedRedirect: bare, redirectTitle: bare ? info.source : null };
  if (titleMatchesTerm(term, info.title, { corporate })) return { ...none(), title: info.title, match: 'redirect' };
  // "Donald Trump mugshot" -> "Mug shot of Donald Trump": the target is
  // the same subject under another title when every word of the term is
  // in it. Never for a single word: "Clavicular" -> "Clavicle" is the
  // bone, and single words are where the generic-term guard matters.
  const tokens = normalizeTitle(term).split(' ').filter(Boolean);
  if (tokens.length >= 2) {
    const target = normalizeTitle(info.title);
    const letters = target.replace(/ /g, '');
    const words = new Set(target.split(' '));
    const all = tokens.every((t) => (t.length < 3 ? words.has(t) : letters.includes(t)));
    if (all) return { ...none(), title: info.title, match: 'redirect' };
  }
  return none();
}

// The article whose pageviews stand for a term: OpenSearch candidates
// that are the term itself (plain first, then company-suffixed when
// `corporate`), each checked for redirects and disambiguation. The first
// that survives wins.
export async function resolvePageviewArticle(term: string, { corporate = false } = {}): Promise<CandidateVerdict> {
  const candidates = await resolveArticleTitles(term, { corporate: true });
  const plain = candidates.filter((t) => titleMatchesTerm(term, t));
  const suffixed = corporate ? candidates.filter((t) => !plain.includes(t)) : [];
  // The bare term itself is judged first even when OpenSearch ranks a
  // qualified title above it, so that a disambiguation page or a section
  // redirect under the term's own name is seen.
  const ordered = [term, ...plain, ...suffixed].filter((t, i, all) => all.indexOf(t) === i);
  if (ordered.length === 0) return none();
  const pages = await lookupPages(ordered);
  const verdict = none();
  for (const requested of ordered) {
    const info = pages.get(requested);
    if (!info) continue;
    const v = judgeCandidate(term, info, { corporate });
    verdict.ambiguous ||= v.ambiguous;
    verdict.namedRedirect ||= v.namedRedirect;
    verdict.redirectTitle ??= v.redirectTitle;
    if (v.title) return { ...v, ambiguous: verdict.ambiguous, namedRedirect: verdict.namedRedirect, redirectTitle: verdict.redirectTitle };
  }
  return verdict;
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

// The article's intro, from the REST summary endpoint: `extract` is the
// lead paragraph as plain text, `description` the one-line short
// description. Null when there is no such page.
export async function fetchArticleSummary(
  title: string
): Promise<{ extract: string | null; description: string | null } | null> {
  const res = await fetch(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title.replace(/ /g, '_'))}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`summary ${res.status}`);
  const body = (await res.json()) as { extract?: string; description?: string; type?: string };
  if (body.type === 'disambiguation') return null;
  return { extract: body.extract?.trim() || null, description: body.description?.trim() || null };
}

// The first sentence or two of a paragraph, for a caption: whole sentences
// only, up to about `max` characters, and never less than one sentence.
export function leadSentences(text: string, max = 220): string {
  const clean = decodeEntities(text).replace(/\s+/g, ' ').replace(/\s+\(([^)]*\b(?:pronounced|pronunciation|listen)\b[^)]*)\)/gi, '').trim();
  const parts = clean.split(/(?<=[.!?])\s+(?=["“(A-Z0-9])/);
  let out = '';
  for (const part of parts) {
    if (out && (out + ' ' + part).length > max) break;
    out = out ? `${out} ${part}` : part;
  }
  return out.length > max * 1.6 ? `${out.slice(0, max * 1.6 - 1).trimEnd()}…` : out;
}

// og:description arrives HTML-escaped from some sites (Know Your Meme
// writes &apos;).
function decodeEntities(s: string): string {
  return s
    .replace(/&apos;|&#39;|&#x27;/g, "'")
    .replace(/&quot;|&#34;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ');
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
