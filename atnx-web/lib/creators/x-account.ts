// Own-account reach on X: the impressions a verified account's own posts
// draw, the counterpart of channel.ts for YouTube. The X source reads talk
// about a name; for the biggest people and brands their own posts draw far
// more attention than the talk does, and the talk read is capped besides.
//
// Every six hours the account's twenty newest posts are fetched (one page,
// about 20 x $0.00015), retweets of other people's posts are dropped, and
// the views on what remains are spread over the days they cover: own
// impressions a day. Written to vi_samples (source x_account) and read
// onto the X component's meta (own_views_per_h), where the model takes the
// larger of talk and own reach (lib/vi/score.ts xReading).
import { createAdminClient } from '@/lib/supabase/admin';
import { readSamples, writeSample, type Sample } from '@/lib/vi/samples';
import { USD_PER_TWEET, xConfigured } from '@/lib/vi/x';

const API = 'https://api.twitterapi.io/twitter/user/last_tweets';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
export const X_ACCOUNT_SOURCE = 'x_account';
export const READ_EVERY_MS = 6 * HOUR;
const READ_SLACK_MS = 15 * 60 * 1000;
// A reading older than this no longer stands for the account.
const MAX_AGE_MS = 2 * DAY;
const WINDOW_DAYS = 7;
const PAGE = 20;

export interface OwnPost {
  createdAt: string;
  viewCount?: number;
  retweeted_tweet?: unknown;
}

export interface OwnReach {
  // Impressions a day on the account's own posts; null with no posts read.
  perDay: number | null;
  posts: number; // own posts counted (retweets dropped)
  windowDays: number;
}

// Views on the account's own posts of the last week, per day. The pages
// are the newest posts; when they cover less than a week the window is
// the span they cover (at least a day), so a prolific account is not
// undercounted. Retweets carry the original's views and are not the
// account's own reach. Pure.
export function ownImpressionsPerDay(posts: OwnPost[], now = Date.now()): OwnReach {
  const own = posts
    .filter((p) => !p.retweeted_tweet)
    .map((p) => ({ t: Date.parse(p.createdAt), views: Number(p.viewCount ?? 0) }))
    .filter((p) => Number.isFinite(p.t) && now - p.t <= WINDOW_DAYS * DAY && p.t <= now + HOUR);
  if (posts.length === 0) return { perDay: null, posts: 0, windowDays: WINDOW_DAYS };
  if (own.length === 0) return { perDay: 0, posts: 0, windowDays: WINDOW_DAYS };
  const oldest = Math.min(...own.map((p) => p.t));
  // A full page all inside the week covers only its own span.
  const windowDays = posts.length >= PAGE ? Math.min(WINDOW_DAYS, Math.max(1, (now - oldest) / DAY)) : WINDOW_DAYS;
  const views = own.reduce((s, p) => s + p.views, 0);
  return { perDay: Math.round(views / windowDays), posts: own.length, windowDays: Number(windowDays.toFixed(2)) };
}

// An account that mostly retweets (Musk: 17 of 20) leaves a thin sample of
// its own posts on one page; a second page is fetched when fewer than
// MIN_OWN_POSTS own posts came back and the week is not yet covered.
const MIN_OWN_POSTS = 5;
const MAX_PAGES = 2;

async function fetchPage(userName: string, cursor: string): Promise<{ tweets: OwnPost[]; next: string | null } | null> {
  const res = await fetch(`${API}?${new URLSearchParams(cursor ? { userName, cursor } : { userName })}`, {
    headers: { 'X-API-Key': process.env.TWITTERAPI_IO_KEY ?? '', Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.error(`[creators:x] last_tweets ${res.status} for ${userName}: ${(await res.text()).slice(0, 120)}`);
    return null;
  }
  const body = (await res.json()) as { status?: string; data?: { tweets?: OwnPost[] }; tweets?: OwnPost[]; has_next_page?: boolean; next_cursor?: string };
  if (body.status && body.status !== 'success') return null;
  return { tweets: body.data?.tweets ?? body.tweets ?? [], next: body.has_next_page && body.next_cursor ? body.next_cursor : null };
}

// Whether another page is worth its cost: few own posts so far, and the
// oldest post fetched is still inside the week. Pure.
export function wantsAnotherPage(posts: OwnPost[], now = Date.now()): boolean {
  const own = posts.filter((p) => !p.retweeted_tweet).length;
  if (own >= MIN_OWN_POSTS || posts.length === 0) return false;
  const oldest = Math.min(...posts.map((p) => Date.parse(p.createdAt)).filter(Number.isFinite));
  return Number.isFinite(oldest) && now - oldest < WINDOW_DAYS * DAY;
}

async function fetchOwnPosts(userName: string, now = Date.now()): Promise<OwnPost[] | null> {
  const posts: OwnPost[] = [];
  let cursor = '';
  for (let page = 0; page < MAX_PAGES; page++) {
    const r = await fetchPage(userName, cursor);
    if (!r) return page === 0 ? null : posts;
    posts.push(...r.tweets);
    if (!r.next || !wantsAnotherPage(posts, now)) break;
    cursor = r.next;
  }
  return posts;
}

export interface XHandle {
  market_id: string;
  handle: string;
  verified_at: string | null;
}

export async function verifiedXHandles(marketIds?: string[]): Promise<XHandle[]> {
  let q = createAdminClient().from('market_handles').select('market_id, handle, verified_at').eq('platform', 'x').eq('status', 'verified');
  if (marketIds) q = q.in('market_id', marketIds);
  const { data, error } = await q;
  if (error) {
    console.error('[creators:x] handles', error.message);
    return [];
  }
  return ((data ?? []) as XHandle[]).filter((h) => !!h.handle);
}

export interface XAccountJobSummary {
  accounts: number;
  reads: number;
  tweets: number;
  estUsd: number;
  skipped?: string;
}

// The newest reading of an account, if fresh enough. Pure over samples
// (newest first).
export function latestOwnReach(samples: Sample[], handle: string, now = Date.now()): { perDay: number; posts: number; readAt: string } | null {
  const s = samples.find((x) => x.meta?.handle === handle && now - Date.parse(x.sampled_at) <= MAX_AGE_MS);
  if (!s) return null;
  return { perDay: Number(s.value), posts: Number(s.meta?.posts ?? 0), readAt: s.sampled_at };
}

// Reads every verified account whose last reading is six hours old.
export async function runXAccountJob(now = Date.now(), marketIds?: string[]): Promise<XAccountJobSummary> {
  const summary: XAccountJobSummary = { accounts: 0, reads: 0, tweets: 0, estUsd: 0 };
  if (!xConfigured()) return { ...summary, skipped: 'TWITTERAPI_IO_KEY not set' };
  const handles = await verifiedXHandles(marketIds);
  summary.accounts = handles.length;
  for (const h of handles) {
    const samples = await readSamples(h.market_id, X_ACCOUNT_SOURCE, 5);
    const last = samples.find((s) => s.meta?.handle === h.handle);
    if (last && now - Date.parse(last.sampled_at) < READ_EVERY_MS - READ_SLACK_MS) continue;
    const posts = await fetchOwnPosts(h.handle, now);
    if (posts === null) continue;
    const reach = ownImpressionsPerDay(posts, now);
    summary.reads++;
    summary.tweets += posts.length;
    // `tweets` feeds the X daily budget ledger (lib/vi/x.ts).
    await writeSample(h.market_id, X_ACCOUNT_SOURCE, reach.perDay ?? 0, { kind: 'own', handle: h.handle, tweets: posts.length, posts: reach.posts, window_days: reach.windowDays, read: reach.perDay === null ? 0 : 1 });
  }
  summary.estUsd = Number((summary.tweets * USD_PER_TWEET).toFixed(4));
  return summary;
}

// The account's reach as fields on the X component's meta.
export async function readXAccountMeta(marketId: string, handle: string, now = Date.now()): Promise<Record<string, string | number | null>> {
  const r = latestOwnReach(await readSamples(marketId, X_ACCOUNT_SOURCE, 10), handle, now);
  return {
    x_handle: handle,
    own_views_per_h: r ? Math.round(r.perDay / 24) : null,
    own_impressions_24h: r ? r.perDay : null,
    own_posts: r ? r.posts : null,
    own_read_at: r ? r.readAt : null,
  };
}
