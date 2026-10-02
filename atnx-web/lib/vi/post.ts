// The captured posts themselves as a VI source. Every other source counts
// where a name is talked about or searched for; a meme that lives as one
// viral post, reposted and captioned but rarely tagged, shows up nowhere
// ("Nosfercatu", 2026-10-02: 9.7M plays on the post, 15 views an hour on
// its hashtag, 0 everywhere else). The capture knows the exact post
// (captures.source_url), so this source reads that post's own counts.
//
// The reading is views a day, the TikTok unit (lib/vi/score.ts
// CALIBRATION): on a post's first read its lifetime views over its age,
// a measured average rather than a guess, since the platforms return the
// creation time; from the second read on, the growth between reads. A
// market's reading is the sum over its captured posts (the newest
// MAX_POSTS_PER_MARKET). The momentum compares today's rate with the
// rate a day earlier, once there are reads a day apart.
//
// Read on the slow (hourly) pass: every pass through a market's first day
// (the rate changes fastest then, and the first trades happen then), every
// three hours after. The new-market scoring reads it at creation, so the
// market goes live with the post term in its total. One actor run per
// platform per pass carries every due post (prefetchPosts), like TikTok's
// hashtags; each market reads its rows from the batch.
//
//   TikTok     apidojo/tiktok-scraper, $0.0003 a post, exact counts and
//              the upload time (clockworks rounds to "9.7M").
//   Instagram  apify/instagram-post-scraper, $0.0027 a post; a video's
//              play count. A photo post has no view count and reads as
//              unknown (its likes are recorded).
//   X          twitterapi.io tweet lookup, one request per 100 ids.
//
// Bounded by a daily read budget from the samples ledger
// (POST_DAILY_READ_BUDGET), a per-run cap, and a pause after a vendor
// refusal. Without a token the platform is unknown.
import { clamp, ratioToBaseline, type SourceComponent } from './score';
import { createAdminClient } from '../supabase/admin';
import { dailyLedger, pruneSamples, readSamples, writeSample, type Sample } from './samples';

export type PostPlatform = 'tiktok' | 'instagram' | 'x';

export interface PostRef {
  platform: PostPlatform;
  id: string;
  // Canonical form, what the scrapers are given.
  url: string;
}

export interface PostStats {
  ref: PostRef;
  // Null when the platform shows no view count for this post.
  views: number | null;
  likes: number | null;
  shares: number | null;
  comments: number | null;
  // ISO, or null when the platform did not say.
  createdAt: string | null;
}

export const MAX_POSTS_PER_MARKET = 5;
// Reads a day across all markets before the source stops for the day.
// 300 is under a dollar even if every read were Instagram.
const DEFAULT_DAILY_BUDGET = 300;
const MAX_POSTS_PER_RUN = 100;
const TIKTOK_ACTOR = 'apidojo~tiktok-scraper';
const INSTAGRAM_ACTOR = 'apify~instagram-post-scraper';
const APIFY = 'https://api.apify.com/v2/acts';
const X_API = 'https://api.twitterapi.io/twitter/tweets';
const RUN_TIMEOUT_S = 120;
const PAUSE_MS = 30 * 60 * 1000;
const LEDGER_TTL = 5 * 60 * 1000;
// Hourly through the first day, three-hourly after; the slow pass runs
// at :07, so each interval gets slack to be taken by the pass it is due at.
export const YOUNG_MS = 24 * 3600 * 1000;
export const YOUNG_INTERVAL_MS = 3600 * 1000;
export const INTERVAL_MS = 3 * 3600 * 1000;
const INTERVAL_SLACK_MS = 15 * 60 * 1000;
// Two reads this close are one read.
export const MIN_GAP_H = 0.75;
// A post whose newest read is older than this has no current rate.
const STALE_H = 9;
// A post's lifetime average needs at least this much age, else a
// minutes-old post reads as millions a day.
const MIN_AGE_H = 1;
// Momentum: the rate a day ago, from reads this far back.
const BASELINE_MIN_H = 20;
const BASELINE_MAX_H = 30;
const SAMPLE_KEEP_MS = 3 * 24 * 3600 * 1000;
const MAX_SAMPLES = 120;

let pausedUntil = 0;
let batch: Promise<Map<string, PostStats[]>> | null = null;
let batchStarted = 0;
let ledger: { spent: number; at: number } | null = null;
let readThisProcess = 0;

export function postDailyBudget(): number {
  const raw = process.env.POST_DAILY_READ_BUDGET;
  if (raw === undefined || raw === '') return DEFAULT_DAILY_BUDGET;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_BUDGET;
}

export function postPlatformConfigured(platform: PostPlatform): boolean {
  return platform === 'x' ? !!process.env.TWITTERAPI_IO_KEY : !!process.env.APIFY_TOKEN;
}

// The post a URL points at, or null for anything else (a profile, a
// hashtag page, a short link that needs a redirect to resolve). Pure.
export function parsePostUrl(raw: string | null | undefined): PostRef | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|mobile)\./, '').toLowerCase();
  const path = u.pathname;
  if (host === 'tiktok.com') {
    const m = path.match(/^\/@([^/]+)\/(?:video|photo)\/(\d+)/);
    if (m) return { platform: 'tiktok', id: m[2], url: `https://www.tiktok.com/@${m[1]}/video/${m[2]}` };
    return null;
  }
  if (host === 'instagram.com') {
    const m = path.match(/^\/(?:[^/]+\/)?(?:p|reel|reels|tv)\/([A-Za-z0-9_-]+)/);
    if (m) return { platform: 'instagram', id: m[1], url: `https://www.instagram.com/p/${m[1]}/` };
    return null;
  }
  if (host === 'x.com' || host === 'twitter.com') {
    const m = path.match(/^\/[^/]+\/status(?:es)?\/(\d+)/);
    if (m) return { platform: 'x', id: m[1], url: `https://x.com/i/status/${m[1]}` };
    return null;
  }
  return null;
}

export const postKey = (ref: Pick<PostRef, 'platform' | 'id'>): string => `${ref.platform}:${ref.id}`;

// A TikTok short link, the form the app's share sheet hands out
// ("vm.tiktok.com/ZN8hQ3sSs/", "tiktok.com/t/ZN8hQ3sSs/"): it names the
// post only after a redirect. Pure.
export function isTiktokShortLink(raw: string | null | undefined): boolean {
  if (!raw) return false;
  try {
    const u = new URL(raw.trim());
    const host = u.hostname.replace(/^www\./, '').toLowerCase();
    return host === 'vm.tiktok.com' || host === 'vt.tiktok.com' || (host === 'tiktok.com' && /^\/t\/[A-Za-z0-9]+/.test(u.pathname));
  } catch {
    return false;
  }
}

// The canonical post URL TikTok's oEmbed answer names. Pure.
export function tiktokRefFromOembed(body: { author_unique_id?: unknown; embed_product_id?: unknown }): PostRef | null {
  const author = typeof body.author_unique_id === 'string' ? body.author_unique_id.trim() : '';
  const id = typeof body.embed_product_id === 'string' && /^\d+$/.test(body.embed_product_id) ? body.embed_product_id : '';
  return author && id ? { platform: 'tiktok', id, url: `https://www.tiktok.com/@${author}/video/${id}` } : null;
}

const shortLinks = new Map<string, PostRef | null>();

// The post a URL points at, resolving a TikTok short link through oEmbed
// (one request, remembered for the process). Null for anything else or
// when TikTok does not answer.
export async function resolvePostUrl(raw: string | null | undefined): Promise<PostRef | null> {
  const direct = parsePostUrl(raw);
  if (direct || !raw || !isTiktokShortLink(raw)) return direct;
  const key = raw.trim();
  if (shortLinks.has(key)) return shortLinks.get(key) ?? null;
  let ref: PostRef | null = null;
  try {
    const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(key)}`, { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
    if (res.ok) ref = tiktokRefFromOembed((await res.json()) as { author_unique_id?: unknown; embed_product_id?: unknown });
  } catch (err) {
    console.warn(`[post] short link ${key}: ${(err as Error).message}`);
    return null; // not remembered: a timeout is worth another try next pass
  }
  shortLinks.set(key, ref);
  return ref;
}

// Views a day to level, log scale: 1k/day -> 100, 10k -> 300, 100k -> 500,
// 1M -> 700, 10M -> 900. Pure.
export function postLevel(viewsPerDay: number): number {
  if (viewsPerDay < 1) return 0;
  return clamp(Math.round(100 + 200 * Math.log10(viewsPerDay / 1000)));
}

// Whether a market's stored reading is due a read now: never read, the
// three-hour interval, or the hourly one through the first day after the
// first read. Pure.
export function postReadDue(stored: SourceComponent | null | undefined, now = Date.now()): boolean {
  if (!stored) return true;
  const at = Date.parse(stored.fetchedAt);
  if (!Number.isFinite(at)) return true;
  const first = typeof stored.meta?.first_read_at === 'string' ? Date.parse(stored.meta.first_read_at) : at;
  const interval = Number.isFinite(first) && now - first < YOUNG_MS ? YOUNG_INTERVAL_MS : INTERVAL_MS;
  return now - at >= interval - INTERVAL_SLACK_MS;
}

export interface PostReading {
  // Null when no post has a reading.
  viewsPerDay: number | null;
  momentum: number | null;
  // Posts with a reading, and how many of them are on their lifetime
  // average (one read so far).
  posts: number;
  onAverage: number;
}

interface Point {
  h: number;
  v: number;
}

// The rate of one post from its reads, newest first, in views an hour:
// the newest pair at least MIN_GAP_H apart, or the lifetime average when
// there is one read. Null when the post has no current reading. Pure.
function postRate(reads: Sample[], now: number): { rate: number; onAverage: boolean; baseline: number | null } | null {
  const pts: Point[] = [];
  for (const s of reads) {
    const views = typeof s.meta?.views === 'number' ? s.meta.views : null;
    const h = Date.parse(s.sampled_at) / 3600_000;
    if (views === null || !Number.isFinite(h)) continue;
    pts.push({ h, v: views });
  }
  if (pts.length === 0) return null;
  const newest = pts[0];
  if (now / 3600_000 - newest.h > STALE_H) return null;

  let rate: number | null = null;
  let onAverage = false;
  const prev = pts.find((p) => newest.h - p.h >= MIN_GAP_H);
  if (prev) rate = Math.max(0, (newest.v - prev.v) / (newest.h - prev.h));
  else {
    const created = typeof reads[0]?.meta?.created_at === 'string' ? Date.parse(reads[0].meta.created_at) / 3600_000 : NaN;
    if (!Number.isFinite(created)) return null;
    const ageH = Math.max(MIN_AGE_H, newest.h - created);
    rate = newest.v / ageH;
    onAverage = true;
  }

  // The rate a day ago: the newest pair whose later read is 20-30 h back.
  let baseline: number | null = null;
  const back = pts.filter((p) => newest.h - p.h >= BASELINE_MIN_H && newest.h - p.h <= BASELINE_MAX_H);
  if (back.length >= 2) {
    const later = back[0];
    const earlier = back.find((p) => later.h - p.h >= MIN_GAP_H);
    if (earlier) baseline = Math.max(0, (later.v - earlier.v) / (later.h - earlier.h));
  }
  return { rate, onAverage, baseline };
}

// A market's reading from its post samples (newest first, every post
// mixed): the sum of its posts' rates, in views a day. Momentum only when
// every counted post has a rate a day ago. Pure.
export function postReading(samples: Sample[], now = Date.now()): PostReading {
  const byPost = new Map<string, Sample[]>();
  for (const s of samples) {
    const key = typeof s.meta?.post === 'string' ? s.meta.post : null;
    if (!key) continue;
    const list = byPost.get(key) ?? [];
    list.push(s);
    byPost.set(key, list);
  }
  let sum = 0;
  let base = 0;
  let posts = 0;
  let onAverage = 0;
  let baselined = 0;
  for (const reads of byPost.values()) {
    const r = postRate(reads, now);
    if (!r) continue;
    posts++;
    sum += r.rate;
    if (r.onAverage) onAverage++;
    if (r.baseline !== null) {
      baselined++;
      base += r.baseline;
    }
  }
  if (posts === 0) return { viewsPerDay: null, momentum: null, posts: 0, onAverage: 0 };
  const momentum = baselined === posts ? ratioToBaseline(sum, [base]) : null;
  return { viewsPerDay: Math.round(sum * 24), momentum, posts, onAverage };
}

// --- Fetching ---------------------------------------------------------------

async function apifyRun<T>(actor: string, input: unknown): Promise<T[] | null> {
  const res = await fetch(`${APIFY}/${actor}/run-sync-get-dataset-items?token=${encodeURIComponent(process.env.APIFY_TOKEN ?? '')}&timeout=${RUN_TIMEOUT_S}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    cache: 'no-store',
    signal: AbortSignal.timeout((RUN_TIMEOUT_S + 30) * 1000),
  });
  if (!res.ok) {
    console.error(`[post] ${actor} ${res.status}: ${(await res.text()).slice(0, 160)}`);
    pausedUntil = Date.now() + PAUSE_MS;
    return null;
  }
  const body = await res.json();
  return Array.isArray(body) ? (body as T[]) : null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v)) ? Number(v) : null);

async function fetchTiktok(refs: PostRef[]): Promise<Map<string, PostStats>> {
  const out = new Map<string, PostStats>();
  if (refs.length === 0) return out;
  type Row = { id?: string; views?: unknown; likes?: unknown; shares?: unknown; comments?: unknown; uploadedAt?: unknown };
  const rows = await apifyRun<Row>(TIKTOK_ACTOR, { startUrls: refs.map((r) => r.url), maxItems: refs.length });
  for (const row of rows ?? []) {
    const ref = refs.find((r) => r.id === String(row.id ?? ''));
    if (!ref) continue;
    const uploaded = num(row.uploadedAt);
    out.set(postKey(ref), {
      ref,
      views: num(row.views),
      likes: num(row.likes),
      shares: num(row.shares),
      comments: num(row.comments),
      createdAt: uploaded !== null ? new Date(uploaded * 1000).toISOString() : null,
    });
  }
  return out;
}

async function fetchInstagram(refs: PostRef[]): Promise<Map<string, PostStats>> {
  const out = new Map<string, PostStats>();
  if (refs.length === 0) return out;
  type Row = { shortCode?: string; videoPlayCount?: unknown; videoViewCount?: unknown; likesCount?: unknown; commentsCount?: unknown; timestamp?: unknown };
  const rows = await apifyRun<Row>(INSTAGRAM_ACTOR, { username: refs.map((r) => r.url), resultsLimit: 1 });
  for (const row of rows ?? []) {
    const ref = refs.find((r) => r.id === row.shortCode);
    if (!ref) continue;
    const ts = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
    out.set(postKey(ref), {
      ref,
      views: num(row.videoPlayCount) ?? num(row.videoViewCount),
      likes: num(row.likesCount),
      shares: null,
      comments: num(row.commentsCount),
      createdAt: Number.isFinite(ts) ? new Date(ts).toISOString() : null,
    });
  }
  return out;
}

async function fetchX(refs: PostRef[]): Promise<Map<string, PostStats>> {
  const out = new Map<string, PostStats>();
  for (let i = 0; i < refs.length; i += 100) {
    const chunk = refs.slice(i, i + 100);
    const res = await fetch(`${X_API}?tweet_ids=${chunk.map((r) => r.id).join(',')}`, {
      headers: { 'X-API-Key': process.env.TWITTERAPI_IO_KEY ?? '', Accept: 'application/json' },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) {
      console.error(`[post] x ${res.status}: ${(await res.text()).slice(0, 120)}`);
      pausedUntil = Date.now() + PAUSE_MS;
      break;
    }
    const body = (await res.json()) as { tweets?: { id?: string; viewCount?: unknown; likeCount?: unknown; retweetCount?: unknown; replyCount?: unknown; createdAt?: unknown }[] };
    for (const t of body.tweets ?? []) {
      const ref = chunk.find((r) => r.id === String(t.id ?? ''));
      if (!ref) continue;
      const ts = typeof t.createdAt === 'string' ? Date.parse(t.createdAt) : NaN;
      out.set(postKey(ref), { ref, views: num(t.viewCount), likes: num(t.likeCount), shares: num(t.retweetCount), comments: num(t.replyCount), createdAt: Number.isFinite(ts) ? new Date(ts).toISOString() : null });
    }
  }
  return out;
}

export async function fetchPostStats(refs: PostRef[]): Promise<Map<string, PostStats>> {
  const by = (p: PostPlatform) => refs.filter((r) => r.platform === p && postPlatformConfigured(p));
  const parts = await Promise.all([fetchTiktok(by('tiktok')).catch(() => new Map<string, PostStats>()), fetchInstagram(by('instagram')).catch(() => new Map<string, PostStats>()), fetchX(by('x')).catch(() => new Map<string, PostStats>())]);
  const out = new Map<string, PostStats>();
  for (const part of parts) for (const [k, v] of part) out.set(k, v);
  return out;
}

// The posts a market was captured from: its captures' source URLs that
// point at a post, newest first, distinct, at most MAX_POSTS_PER_MARKET.
export async function postsForMarkets(marketIds: string[]): Promise<Map<string, PostRef[]>> {
  const out = new Map<string, PostRef[]>();
  if (marketIds.length === 0) return out;
  const { data, error } = await createAdminClient()
    .from('captures')
    .select('market_id, source_url, created_at')
    .in('market_id', marketIds)
    .is('deleted_at', null)
    .not('source_url', 'is', null)
    .order('created_at', { ascending: false });
  if (error) {
    console.error(`[post] captures lookup failed: ${error.message}`);
    return out;
  }
  const rows = (data ?? []) as { market_id: string; source_url: string | null }[];
  const refs = await Promise.all(rows.map((row) => resolvePostUrl(row.source_url)));
  for (const [i, row] of rows.entries()) {
    const ref = refs[i];
    if (!ref) continue;
    const list = out.get(row.market_id) ?? [];
    if (list.length >= MAX_POSTS_PER_MARKET || list.some((r) => postKey(r) === postKey(ref))) continue;
    list.push(ref);
    out.set(row.market_id, list);
  }
  return out;
}

async function budgetLeft(): Promise<number> {
  const budget = postDailyBudget();
  if (budget === 0) return 0;
  if (!ledger || Date.now() - ledger.at > LEDGER_TTL) {
    ledger = { spent: await dailyLedger('post', 'reads'), at: Date.now() };
    readThisProcess = 0;
  }
  return budget - ledger.spent - readThisProcess;
}

export interface PostRequest {
  marketId?: string | null;
  stored?: SourceComponent | null;
}

// Starts the pass's reads for the markets due one, under the day's
// budget and the run cap. The adapters await the result. Returns at once.
export function prefetchPosts(requests: PostRequest[], now = Date.now()): void {
  if (now < pausedUntil) return;
  const due = requests.filter((r) => r.marketId && postReadDue(r.stored, now)).map((r) => r.marketId as string);
  if (due.length === 0) return;
  batchStarted = now;
  batch = (async () => {
    const result = new Map<string, PostStats[]>();
    try {
      const posts = await postsForMarkets(due);
      const refs: { marketId: string; ref: PostRef }[] = [];
      for (const id of due) for (const ref of posts.get(id) ?? []) refs.push({ marketId: id, ref });
      if (refs.length === 0) return result;
      const left = await budgetLeft();
      const wanted = refs.slice(0, Math.max(0, Math.min(MAX_POSTS_PER_RUN, left)));
      if (wanted.length < refs.length) console.error(`[post] ${refs.length - wanted.length} of ${refs.length} post reads wait (budget ${postDailyBudget()}/day, run cap ${MAX_POSTS_PER_RUN})`);
      if (wanted.length === 0) return result;
      readThisProcess += wanted.length;
      const unique = [...new Map(wanted.map((w) => [postKey(w.ref), w.ref])).values()];
      const stats = await fetchPostStats(unique);
      for (const w of wanted) {
        const s = stats.get(postKey(w.ref));
        if (!s) continue;
        const list = result.get(w.marketId) ?? [];
        list.push(s);
        result.set(w.marketId, list);
      }
    } catch (err) {
      console.error(`[post] batch failed: ${(err as Error).message}`);
    }
    return result;
  })();
}

export async function fetchPostSignal(req: PostRequest): Promise<SourceComponent | null> {
  const { marketId, stored } = req;
  const now = Date.now();
  if (!marketId) return null;
  if (!postReadDue(stored, now)) return stored ?? null;
  if (!batch || now - batchStarted > 20 * 60 * 1000) return stored ?? null; // not in this pass's run

  const mine = (await batch).get(marketId);
  // No captured post, beyond the cap, or the run failed: the stored
  // reading stands, and a market with none gets no component at all
  // (null is left out of the breakdown, lib/signals.ts) rather than an
  // unknown on every market that was captured from a search page.
  if (!mine || mine.length === 0) return stored ?? null;

  for (const s of mine) {
    await writeSample(marketId, 'post', s.views ?? 0, {
      post: postKey(s.ref),
      platform: s.ref.platform,
      created_at: s.createdAt,
      views: s.views,
      likes: s.likes,
      shares: s.shares,
      comments: s.comments,
      reads: 1,
    });
  }
  const reading = postReading(await readSamples(marketId, 'post', MAX_SAMPLES), now);
  await pruneSamples(marketId, 'post', SAMPLE_KEEP_MS);
  const firstReadAt = typeof stored?.meta?.first_read_at === 'string' ? stored.meta.first_read_at : new Date(now).toISOString();
  return {
    source: 'post',
    level: reading.viewsPerDay === null ? null : postLevel(reading.viewsPerDay),
    momentum: reading.momentum,
    fetchedAt: new Date(now).toISOString(),
    meta: {
      views_per_day: reading.viewsPerDay,
      posts: mine.length,
      posts_read: reading.posts,
      on_average: reading.onAverage,
      first_read_at: firstReadAt,
      newest: postKey(mine[0].ref),
    },
  };
}

// --- The review step's link ---------------------------------------------------

export interface VerifiedPostLink {
  ref: PostRef;
  // Whether the post's author appears in the text read from the image;
  // null when the platform did not say who posted it.
  authorMatched: boolean | null;
}

// A link the reviewer added to a screenshot: it must point at a post on a
// platform this source reads, and the post must exist. Throws with a
// message the reviewer can act on.
export async function verifyPostLink(raw: string, ocrText: string | null | undefined): Promise<VerifiedPostLink> {
  const ref = await resolvePostUrl(raw);
  if (!ref) throw new Error(isTiktokShortLink(raw) ? 'TikTok has no post at that link' : 'The link must be to a TikTok video, an Instagram post or reel, or an X post');
  const ocr = (ocrText ?? '').toLowerCase();
  const seen = (names: (string | null | undefined)[]) => {
    const got = names.filter((n): n is string => !!n && n.trim().length >= 3).map((n) => n.trim().toLowerCase());
    return got.length ? got.some((n) => ocr.includes(n)) : null;
  };
  if (ref.platform === 'tiktok') {
    const res = await fetch(`https://www.tiktok.com/oembed?url=${encodeURIComponent(ref.url)}`, { cache: 'no-store', signal: AbortSignal.timeout(8_000) }).catch(() => null);
    // A missing post answers 400 ("Something went wrong"), not 404.
    if (res && (res.status === 400 || res.status === 404)) throw new Error('TikTok has no post at that link');
    if (!res || !res.ok) throw new Error('Could not reach TikTok to check that link; try again');
    const body = (await res.json()) as { author_name?: string; author_unique_id?: string };
    return { ref, authorMatched: seen([body.author_name, body.author_unique_id]) };
  }
  if (ref.platform === 'x') {
    if (!postPlatformConfigured('x')) return { ref, authorMatched: null };
    const res = await fetch(`${X_API}?tweet_ids=${ref.id}`, { headers: { 'X-API-Key': process.env.TWITTERAPI_IO_KEY ?? '', Accept: 'application/json' }, cache: 'no-store', signal: AbortSignal.timeout(8_000) }).catch(() => null);
    if (!res || !res.ok) throw new Error('Could not reach X to check that link; try again');
    const body = (await res.json()) as { tweets?: { author?: { userName?: string; name?: string } }[] };
    const t = body.tweets?.[0];
    if (!t) throw new Error('X has no post at that link');
    return { ref, authorMatched: seen([t.author?.userName, t.author?.name]) };
  }
  // Instagram answers nothing without a login; the first read verifies it.
  return { ref, authorMatched: null };
}
