// X through twitterapi.io as a VI source. A third-party API, paid per
// tweet returned ($0.15 per 1k, floor $0.00015 per request), with X's
// advanced search operators: one query per market for the name and its
// aliases in the last hour, paged to a cap. The count of posts in the
// hour is the reading; the momentum compares this hour's rate with the
// hours before it, from vi_samples. Views and likes are recorded but
// not scored: an hour-old tweet has barely been seen yet.
//
// The slow path owns it (hourly). Spend is bounded three ways: the page
// cap per market, a daily tweet budget read from the samples ledger, and
// a pause after the vendor refuses (quota, auth, rate limit). Without a
// key the source is unknown.
import { clamp, ratioToBaseline, type SourceComponent } from './score';
import { dailyLedger, pruneSamples, readSamples, writeSample } from './samples';

const API = 'https://api.twitterapi.io/twitter/tweet/advanced_search';
const WINDOW_S = 3600;
const PAGE_SIZE = 20;
const MAX_PAGES = 5;
export const TWEET_CAP = MAX_PAGES * PAGE_SIZE;
const MAX_PHRASES = 4;
const CACHE_TTL = 50 * 60 * 1000;
export const USD_PER_TWEET = 0.00015;
export const USD_PER_REQUEST_MIN = 0.00015;
// Tweets a day across all markets before the source stops for the day.
// 20k is about $3. 0 pauses the source without removing the key.
const DEFAULT_DAILY_BUDGET = 20_000;
const LEDGER_TTL = 5 * 60 * 1000;
const PAUSE_MS = 10 * 60 * 1000;
const SAMPLE_KEEP_MS = 3 * 24 * 3600 * 1000;
const MAX_SAMPLES = 40;
const MIN_PRIOR_SAMPLES = 6;
const BASELINE_MS = 24 * 3600 * 1000;

const cache = new Map<string, { data: SourceComponent; expiry: number }>();
let pausedUntil = 0;
let ledger: { spent: number; at: number } | null = null;
let spentThisProcess = 0;

export function xConfigured(): boolean {
  return !!process.env.TWITTERAPI_IO_KEY;
}

export function xDailyBudget(): number {
  const raw = process.env.X_DAILY_TWEET_BUDGET;
  if (raw === undefined || raw === '') return DEFAULT_DAILY_BUDGET;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_BUDGET;
}

// Posts a day to level, log scale. X is about an order of magnitude
// busier than Bluesky, so the axis is shifted one decade:
//   10/day -> 100, 100 -> 300, 1k -> 500, 10k -> 700, 100k -> 900
export function xLevel(posts24h: number): number {
  if (posts24h < 1) return 0;
  return clamp(Math.round(100 + 200 * Math.log10(Math.max(posts24h, 10) / 10)));
}

interface Tweet {
  id: string;
  createdAt: string;
  viewCount?: number;
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  retweeted_tweet?: unknown;
}

// A hundred tweets inside this span is as fast as the estimate goes:
// 3,000 posts an hour, level ~870. Shorter spans are timestamp noise.
const MIN_SPAN_H = 2 / 60;

// Posts per hour from the fetched tweets. Under the cap the window is
// the hour and the count is the rate; at the cap the true count is
// higher, and the rate is read off the span the fetched tweets cover
// (they arrive newest first, so the oldest bounds it). The span floor
// was a quarter hour at first, which read every busy market as exactly
// 400 an hour: Google, Bitcoin, Trump and Musk all fill five pages in
// well under fifteen minutes.
export function xRate(tweets: { createdAt: string }[], capped: boolean, now = Date.now()): number {
  if (!capped) return tweets.length;
  let oldest = now;
  for (const t of tweets) {
    const ms = Date.parse(t.createdAt);
    if (Number.isFinite(ms) && ms < oldest) oldest = ms;
  }
  const spanH = Math.max(MIN_SPAN_H, (now - oldest) / 3600_000);
  return tweets.length / spanH;
}

export interface XSample {
  sampled_at: string;
  value: number;
}

// This hour's rate against the mean of the prior samples in the last
// day; null until enough of them exist. Samples newest first, the
// current one included.
export function xMomentum(samples: XSample[], current: number, now = Date.now()): number | null {
  const prior = samples
    .filter((s) => {
      const age = now - Date.parse(s.sampled_at);
      return age > 30 * 60 * 1000 && age <= BASELINE_MS;
    })
    .map((s) => s.value);
  if (prior.length < MIN_PRIOR_SAMPLES) return null;
  return ratioToBaseline(current, prior);
}

export function xQuery(term: string, aliases: string[], now = Date.now()): string {
  const phrases = [term, ...aliases]
    .map((p) => p.trim().replace(/"/g, ''))
    .filter((p, i, all) => p.length >= 2 && all.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i)
    .slice(0, MAX_PHRASES)
    .map((p) => `"${p}"`);
  const until = Math.floor(now / 1000);
  const or = phrases.length === 1 ? phrases[0] : `(${phrases.join(' OR ')})`;
  return `${or} since_time:${until - WINDOW_S} until_time:${until} -filter:retweets`;
}

async function budgetLeft(): Promise<number> {
  const budget = xDailyBudget();
  if (budget === 0) return 0;
  if (!ledger || Date.now() - ledger.at > LEDGER_TTL) {
    ledger = { spent: await dailyLedger('x', 'tweets'), at: Date.now() };
    spentThisProcess = 0;
  }
  return budget - ledger.spent - spentThisProcess;
}

export interface XRequest {
  term: string;
  aliases?: string[];
  marketId?: string | null;
}

export async function fetchXSignal({ term, aliases = [], marketId }: XRequest): Promise<SourceComponent> {
  const key = `${marketId ?? ''}|${term.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiry) return hit.data;

  const empty: SourceComponent = { source: 'x', level: null, momentum: null, fetchedAt: new Date().toISOString() };
  if (!xConfigured() || term.trim().length < 2) return empty;
  if (Date.now() < pausedUntil) return empty;
  const left = await budgetLeft();
  if (left <= 0) return empty;

  try {
    const now = Date.now();
    const query = xQuery(term, aliases, now);
    const tweets: Tweet[] = [];
    let cursor = '';
    let requests = 0;
    let capped = false;
    for (let page = 0; page < MAX_PAGES; page++) {
      if (tweets.length + PAGE_SIZE > left) break; // would cross today's budget
      const params = new URLSearchParams({ query, queryType: 'Latest', cursor });
      const res = await fetch(`${API}?${params}`, {
        headers: { 'X-API-Key': process.env.TWITTERAPI_IO_KEY ?? '', Accept: 'application/json' },
        cache: 'no-store',
        signal: AbortSignal.timeout(15_000),
      });
      requests++;
      if (!res.ok) {
        console.error(`[x] ${res.status} for "${term}": ${(await res.text()).slice(0, 120)}`);
        if ([401, 402, 403, 429].includes(res.status)) pausedUntil = Date.now() + PAUSE_MS;
        if (page === 0) return empty;
        break; // keep what the earlier pages gave
      }
      const body = (await res.json()) as { tweets?: Tweet[]; has_next_page?: boolean; next_cursor?: string };
      for (const t of body.tweets ?? []) if (!t.retweeted_tweet) tweets.push(t);
      if (!body.has_next_page || !body.next_cursor || (body.tweets?.length ?? 0) === 0) break;
      cursor = body.next_cursor;
      if (page === MAX_PAGES - 1) capped = true;
    }
    spentThisProcess += tweets.length;

    const rate = xRate(tweets, capped, now);
    const views = tweets.reduce((s, t) => s + (t.viewCount ?? 0), 0);
    const likes = tweets.reduce((s, t) => s + (t.likeCount ?? 0), 0);
    let momentum: number | null = null;
    if (marketId) {
      await writeSample(marketId, 'x', rate, { tweets: tweets.length, requests, capped, views, likes });
      momentum = xMomentum(await readSamples(marketId, 'x', MAX_SAMPLES), rate, now);
      await pruneSamples(marketId, 'x', SAMPLE_KEEP_MS);
    }

    const result: SourceComponent = {
      source: 'x',
      level: xLevel(rate * 24),
      momentum,
      fetchedAt: new Date().toISOString(),
      meta: {
        posts_1h: capped ? `${Math.round(rate)}+` : tweets.length,
        rate_per_h: Number(rate.toFixed(2)),
        tweets: tweets.length,
        requests,
        capped: capped ? 1 : 0,
        views,
        likes,
        phrases: Math.min(MAX_PHRASES, 1 + aliases.length),
      },
    };
    cache.set(key, { data: result, expiry: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.error(`[x] query failed for "${term}": ${(err as Error).message}`);
    return empty;
  }
}

// What a set of readings cost, for the refresh summary.
export function xSpendUsd(readings: { tweets: number; requests: number }[]): number {
  return readings.reduce((s, r) => s + Math.max(r.tweets * USD_PER_TWEET, r.requests * USD_PER_REQUEST_MIN), 0);
}
