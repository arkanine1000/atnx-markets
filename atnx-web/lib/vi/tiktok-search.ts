// TikTok keyword search as a VI source. The hashtag source (lib/vi/tiktok.ts)
// counts videos posted under one tag; the post source (lib/vi/post.ts)
// reads the posts people captured. Between them sits the meme that lives
// as untagged posts nobody captured yet: "Nosfercatu" and "Chemtrails"
// on 2026-10-02 read 0 under their tags and had one captured post each.
// This source asks TikTok's own search for the week's posts naming the
// phrase and reads their plays, the same unit as the other two.
//
// Discovery is clockworks/tiktok-scraper with the video section and the
// past-week filter: the top posts of the week for each phrase, each row
// naming the query it answers, with its plays and upload time. A pass's
// due phrases go out a few queries a run, runs in parallel (twenty in one
// run timed out at three minutes on 2026-10-04); a run that fails loses
// only its own markets. That first read
// gives every post its lifetime average (plays over age); from then on
// the set is re-read every six hours through the cheaper post reader
// (apidojo, lib/vi/post.ts fetchPostStats) and each post's rate is the
// growth between reads. The reading is the sum of the set's rates in
// views a day (postReading, shared with the post source); the momentum
// is that sum against a day earlier. A search repeats every two days,
// daily for a hot market, every three for one that found nothing; the
// set carries posts from the previous search while they are inside the
// week. Posts the market was captured from are left to the post source
// so a view is counted once.
//
// One search is RESULTS_PER_SEARCH results at the actor's tier price plus
// the date filter, about $0.04 on the Starter plan; a re-read is $0.0003
// a post. Bounded by a daily search budget and a daily read budget from
// the samples ledger, a per-run cap, and a pause after a refusal.
// Without a token the source is unknown.
import type { SourceComponent } from './score';
import { dailyLedger, pruneSamples, readSamples, writeSample } from './samples';
import { fetchPostStats, postKey, postLevel, postReading, postsForMarkets, type PostRef, type PostStats } from './post';

const ACTOR = 'clockworks~tiktok-scraper';
const APIFY = 'https://api.apify.com/v2/acts';
const RUN_TIMEOUT_S = 240;
const PAUSE_MS = 30 * 60 * 1000;
const LEDGER_TTL = 5 * 60 * 1000;
const DEFAULT_RESULTS = 10;
const DEFAULT_SEARCH_BUDGET = 40;
const DEFAULT_READ_BUDGET = 400;
const MAX_SEARCHES_PER_PASS = 24;
const QUERIES_PER_RUN = 4;
const PARALLEL_RUNS = 4;
const MAX_READS_PER_RUN = 150;
const HOUR = 3600 * 1000;
// How long a found set stands before the phrase is searched again.
const HOT_TTL = 24 * HOUR;
const BASE_TTL = 48 * HOUR;
const EMPTY_TTL = 72 * HOUR;
const HOT_LEVEL = 600;
const HOT_MOMENTUM = 1.5;
// Re-reads of the set between searches.
export const INTERVAL_MS = 6 * HOUR;
const SLACK_MS = 15 * 60 * 1000;
// A post leaves the set this long after it was uploaded.
export const WINDOW_MS = 7 * 24 * HOUR;
export const MAX_POSTS = 15;
const SAMPLE_KEEP_MS = 3 * 24 * HOUR;
const MAX_SAMPLES = 160;

export function tiktokSearchConfigured(): boolean {
  return Boolean(process.env.APIFY_TOKEN);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

// Searches a day across all markets; 0 pauses the source.
export const tiktokSearchDailyBudget = (): number => envInt('TIKTOK_SEARCH_DAILY_BUDGET', DEFAULT_SEARCH_BUDGET);
// Post re-reads a day across all markets.
export const tiktokSearchDailyReads = (): number => envInt('TIKTOK_SEARCH_DAILY_READS', DEFAULT_READ_BUDGET);
export const resultsPerSearch = (): number => Math.max(1, envInt('TIKTOK_SEARCH_RESULTS', DEFAULT_RESULTS));

// What one search result costs, for the refresh summary and vi:report:
// the actor's tier price plus the past-week filter. $0.0037 + $0.0013 on
// Apify's Free tier, $0.003 + $0.001 on the Starter plan (default).
export function usdPerSearchResult(): number {
  const n = Number(process.env.APIFY_USD_PER_SEARCH_RESULT);
  return Number.isFinite(n) && n > 0 ? n : 0.004;
}
export const USD_PER_POST_READ = 0.0003;

// --- The set -------------------------------------------------------------------

// One post in a market's set: enough to rebuild its URL for a re-read and
// to know when it leaves the window, without a database read.
export interface SetPost {
  author: string;
  id: string;
  // ISO upload time, or null when the platform did not say.
  createdAt: string | null;
}

export const setPostRef = (p: SetPost): PostRef => ({ platform: 'tiktok', id: p.id, url: `https://www.tiktok.com/@${p.author}/video/${p.id}` });

// "author/id/createdDay,author/id/createdDay", the component meta's form.
export function encodeSet(posts: SetPost[]): string {
  return posts.map((p) => `${p.author}/${p.id}/${p.createdAt ? Math.floor(Date.parse(p.createdAt) / 86_400_000) : 0}`).join(',');
}

export function decodeSet(raw: unknown): SetPost[] {
  if (typeof raw !== 'string' || !raw) return [];
  const out: SetPost[] = [];
  for (const part of raw.split(',')) {
    const m = part.match(/^([^/]+)\/(\d+)\/(\d+)$/);
    if (!m) continue;
    const day = Number(m[3]);
    out.push({ author: m[1], id: m[2], createdAt: day > 0 ? new Date(day * 86_400_000).toISOString() : null });
  }
  return out;
}

// Posts still inside the window (an unknown upload time stays). Pure.
export function inWindow(posts: SetPost[], now = Date.now()): SetPost[] {
  return posts.filter((p) => !p.createdAt || now - Date.parse(p.createdAt) < WINDOW_MS);
}

// The set after a search: what the search found, then the previous set's
// posts still in the window, newest first, at most MAX_POSTS, minus the
// posts the market was captured from. Pure.
export function mergeSet(found: SetPost[], previous: SetPost[], captured: Set<string>, now = Date.now()): SetPost[] {
  const seen = new Set<string>();
  const out: SetPost[] = [];
  const by = (p: SetPost) => (p.createdAt ? Date.parse(p.createdAt) : 0);
  for (const p of [...found].sort((a, b) => by(b) - by(a)).concat(inWindow(previous, now).sort((a, b) => by(b) - by(a)))) {
    if (captured.has(`tiktok:${p.id}`) || seen.has(p.id)) continue;
    seen.add(p.id);
    out.push(p);
    if (out.length >= MAX_POSTS) break;
  }
  return out;
}

// --- Due -----------------------------------------------------------------------

function hot(stored: SourceComponent | null | undefined): boolean {
  return (stored?.level ?? 0) >= HOT_LEVEL || (stored?.momentum ?? 0) >= HOT_MOMENTUM;
}

// Whether the phrase is searched again this pass. Pure.
export function searchDue(stored: SourceComponent | null | undefined, now = Date.now()): boolean {
  const at = typeof stored?.meta?.searched_at === 'string' ? Date.parse(stored.meta.searched_at) : NaN;
  if (!Number.isFinite(at)) return true;
  const found = typeof stored?.meta?.found === 'number' ? stored.meta.found : 0;
  const ttl = found === 0 ? EMPTY_TTL : hot(stored) ? HOT_TTL : BASE_TTL;
  return now - at >= ttl - SLACK_MS;
}

// Whether the set is re-read this pass (a search is a read too). Pure.
export function readDue(stored: SourceComponent | null | undefined, now = Date.now()): boolean {
  if (searchDue(stored, now)) return true;
  if (decodeSet(stored?.meta?.posts).length === 0) return false;
  const at = Date.parse(stored?.fetchedAt ?? '');
  return !Number.isFinite(at) || now - at >= INTERVAL_MS - SLACK_MS;
}

// --- Fetching ------------------------------------------------------------------

let pausedUntil = 0;
let ledger: { searched: number; reads: number; at: number } | null = null;
let searchedThisProcess = 0;
let readThisProcess = 0;
interface BatchResult {
  searched: boolean;
  found: number;
  stats: PostStats[];
  set: SetPost[];
}
let batch: Promise<Map<string, BatchResult>> | null = null;
let batchStarted = 0;

async function budgets(): Promise<{ searches: number; reads: number }> {
  if (!ledger || Date.now() - ledger.at > LEDGER_TTL) {
    const [searched, reads] = await Promise.all([dailyLedger('tiktok_search', 'searched'), dailyLedger('tiktok_search', 'reads')]);
    ledger = { searched, reads, at: Date.now() };
    searchedThisProcess = 0;
    readThisProcess = 0;
  }
  return { searches: tiktokSearchDailyBudget() - ledger.searched - searchedThisProcess, reads: tiktokSearchDailyReads() - ledger.reads - readThisProcess };
}

export type Row = { searchQuery?: unknown; id?: unknown; webVideoUrl?: unknown; playCount?: unknown; diggCount?: unknown; shareCount?: unknown; commentCount?: unknown; createTimeISO?: unknown; createTime?: unknown; authorMeta?: { name?: unknown } | null };

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

// One search result as a set post plus its first read. Pure.
export function rowToPost(row: Row): { post: SetPost; stats: PostStats } | null {
  const id = row.id === undefined || row.id === null ? '' : String(row.id);
  if (!/^\d+$/.test(id)) return null;
  const url = typeof row.webVideoUrl === 'string' ? row.webVideoUrl : '';
  const author = url.match(/tiktok\.com\/@([^/]+)\//)?.[1] ?? (typeof row.authorMeta?.name === 'string' ? row.authorMeta.name : '');
  if (!author) return null;
  const iso = typeof row.createTimeISO === 'string' && Number.isFinite(Date.parse(row.createTimeISO)) ? new Date(Date.parse(row.createTimeISO)).toISOString() : null;
  const epoch = num(row.createTime);
  const createdAt = iso ?? (epoch !== null && epoch > 0 ? new Date(epoch * 1000).toISOString() : null);
  const post = { author, id, createdAt };
  return { post, stats: { ref: setPostRef(post), views: num(row.playCount), likes: num(row.diggCount), shares: num(row.shareCount), comments: num(row.commentCount), createdAt } };
}

// One run for every query; the rows come back tagged with the query
// they answer. Null when the run was refused.
async function search(queries: string[]): Promise<Map<string, Row[]> | null> {
  const res = await fetch(`${APIFY}/${ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(process.env.APIFY_TOKEN ?? '')}&timeout=${RUN_TIMEOUT_S}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ searchQueries: queries, searchSection: '/video', videoSearchDateFilter: 'PAST_WEEK', resultsPerPage: resultsPerSearch() }),
    cache: 'no-store',
    signal: AbortSignal.timeout((RUN_TIMEOUT_S + 30) * 1000),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 160);
    console.error(`[tiktok_search] ${res.status}: ${text}`);
    // A run that timed out or failed is this run's problem; a refusal
    // (no credit, a bad token) pauses the source.
    if (!/run-failed|TIMED-OUT/.test(text)) pausedUntil = Date.now() + PAUSE_MS;
    return null;
  }
  const body = await res.json();
  if (!Array.isArray(body)) return null;
  return groupByQuery(body as Row[], queries);
}

// Rows by the query they answer, every asked query present. A row whose
// query is not one that was asked (or is missing) is dropped. Pure.
export function groupByQuery(rows: Row[], queries: string[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>(queries.map((q) => [q, []]));
  const fold = (q: string) => q.trim().toLowerCase();
  const byFolded = new Map(queries.map((q) => [fold(q), q]));
  for (const row of rows) {
    const q = typeof row.searchQuery === 'string' ? byFolded.get(fold(row.searchQuery)) : undefined;
    if (q !== undefined) out.get(q)!.push(row);
  }
  return out;
}

export interface TiktokSearchRequest {
  marketId?: string | null;
  term: string;
  stored?: SourceComponent | null;
}

// Starts the pass's searches and re-reads for the markets due one, under
// the day's budgets and the run caps. The adapters await the result.
// Returns how many searches were started.
export function prefetchTiktokSearch(requests: TiktokSearchRequest[], now = Date.now()): number {
  if (!tiktokSearchConfigured() || now < pausedUntil) return 0;
  const due = requests.filter((r) => r.marketId && r.term.trim() && readDue(r.stored, now));
  if (due.length === 0) return 0;
  const toSearch = due.filter((r) => searchDue(r.stored, now));
  batchStarted = now;
  batch = (async () => {
    const result = new Map<string, BatchResult>();
    try {
      const left = await budgets();
      const searching = toSearch.slice(0, Math.max(0, Math.min(MAX_SEARCHES_PER_PASS, left.searches)));
      if (searching.length < toSearch.length) console.error(`[tiktok_search] ${toSearch.length - searching.length} of ${toSearch.length} searches wait (budget ${tiktokSearchDailyBudget()}/day, run cap ${MAX_SEARCHES_PER_PASS})`);
      searchedThisProcess += searching.length;
      const searchingIds = new Set(searching.map((r) => r.marketId as string));
      const captured = await postsForMarkets(due.map((r) => r.marketId as string));
      const capturedKeys = (id: string) => new Set((captured.get(id) ?? []).map(postKey));

      // The pass's queries, a few a run, runs a few at a time.
      const queries = [...new Set(searching.map((r) => r.term))];
      const chunks: string[][] = [];
      for (let i = 0; i < queries.length; i += QUERIES_PER_RUN) chunks.push(queries.slice(i, i + QUERIES_PER_RUN));
      const byQuery = new Map<string, Row[]>();
      for (let i = 0; i < chunks.length; i += PARALLEL_RUNS) {
        const got = await Promise.all(chunks.slice(i, i + PARALLEL_RUNS).map((c) => search(c).catch(() => null)));
        for (const g of got) for (const [q, rows] of g ?? []) byQuery.set(q, rows);
      }
      for (const r of searching) {
        const id = r.marketId as string;
        const rows = byQuery.get(r.term);
        if (!rows) continue;
        const parsed = rows.map(rowToPost).filter((x): x is NonNullable<typeof x> => x !== null);
        const set = mergeSet(parsed.map((p) => p.post), decodeSet(r.stored?.meta?.posts), capturedKeys(id), now);
        const keep = new Set(set.map((p) => p.id));
        result.set(id, { searched: true, found: parsed.length, stats: parsed.filter((p) => keep.has(p.post.id)).map((p) => p.stats), set });
      }

      // Re-reads of the sets not searched this pass.
      const reading = due.filter((r) => !searchingIds.has(r.marketId as string));
      const refs: { marketId: string; ref: PostRef }[] = [];
      for (const r of reading) {
        const id = r.marketId as string;
        const keys = capturedKeys(id);
        const set = inWindow(decodeSet(r.stored?.meta?.posts), now).filter((p) => !keys.has(`tiktok:${p.id}`));
        result.set(id, { searched: false, found: typeof r.stored?.meta?.found === 'number' ? r.stored.meta.found : 0, stats: [], set });
        for (const p of set) refs.push({ marketId: id, ref: setPostRef(p) });
      }
      const wanted = refs.slice(0, Math.max(0, Math.min(MAX_READS_PER_RUN, left.reads)));
      if (wanted.length < refs.length) console.error(`[tiktok_search] ${refs.length - wanted.length} of ${refs.length} re-reads wait (budget ${tiktokSearchDailyReads()}/day, run cap ${MAX_READS_PER_RUN})`);
      if (wanted.length > 0) {
        readThisProcess += wanted.length;
        const stats = await fetchPostStats([...new Map(wanted.map((w) => [postKey(w.ref), w.ref])).values()]);
        for (const w of wanted) {
          const s = stats.get(postKey(w.ref));
          if (s) result.get(w.marketId)?.stats.push(s);
        }
      }
    } catch (err) {
      console.error(`[tiktok_search] batch failed: ${(err as Error).message}`);
    }
    return result;
  })();
  return Math.min(toSearch.length, MAX_SEARCHES_PER_PASS);
}

export async function fetchTiktokSearchSignal(req: TiktokSearchRequest): Promise<SourceComponent | null> {
  const { marketId, stored } = req;
  const now = Date.now();
  const unknown = (): SourceComponent => ({ source: 'tiktok_search', level: null, momentum: null, fetchedAt: new Date(now).toISOString(), meta: { ...(stored?.meta ?? {}) } });
  if (!marketId) return null;
  if (!tiktokSearchConfigured()) return unknown();
  if (!readDue(stored, now)) return stored ?? null;
  if (!batch || now - batchStarted > 20 * 60 * 1000) return stored ?? null; // not in this pass's run

  const mine = (await batch).get(marketId);
  // Beyond the caps or the run failed: the stored reading stands.
  if (!mine) return stored ?? null;

  const query = req.term;
  let first = mine.searched;
  for (const s of mine.stats) {
    await writeSample(marketId, 'tiktok_search', s.views ?? 0, {
      post: postKey(s.ref),
      platform: 'tiktok',
      created_at: s.createdAt,
      views: s.views,
      likes: s.likes,
      shares: s.shares,
      comments: s.comments,
      reads: mine.searched ? 0 : 1,
      searched: first ? 1 : 0,
      results: first ? mine.found : 0,
    });
    first = false;
  }
  // A search that found nothing still counts against the day.
  if (first) await writeSample(marketId, 'tiktok_search', 0, { searched: 1, results: 0, reads: 0, query });

  const reading = postReading(await readSamples(marketId, 'tiktok_search', MAX_SAMPLES), now);
  await pruneSamples(marketId, 'tiktok_search', SAMPLE_KEEP_MS);
  const firstReadAt = typeof stored?.meta?.first_read_at === 'string' ? stored.meta.first_read_at : new Date(now).toISOString();
  const searchedAt = mine.searched ? new Date(now).toISOString() : typeof stored?.meta?.searched_at === 'string' ? stored.meta.searched_at : null;
  // A set with nothing in it after a search is a known empty week, 0.
  const level = reading.viewsPerDay === null ? (mine.set.length === 0 && mine.searched ? postLevel(0) : null) : postLevel(reading.viewsPerDay);
  return {
    source: 'tiktok_search',
    level,
    momentum: reading.momentum,
    fetchedAt: new Date(now).toISOString(),
    meta: {
      views_per_day: reading.viewsPerDay ?? (mine.set.length === 0 && mine.searched ? 0 : null),
      posts: encodeSet(mine.set),
      set_size: mine.set.length,
      posts_read: reading.posts,
      on_average: reading.onAverage,
      found: mine.found,
      searched_at: searchedAt,
      first_read_at: firstReadAt,
      query,
    },
  };
}
