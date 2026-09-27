// X through twitterapi.io as a VI source. A third-party API, paid per
// tweet returned ($0.15 per 1k, floor $0.00015 per request), with X's
// advanced search operators: one query per market for the name and its
// aliases in one hour, paged to a cap. The hour read is the one that
// ended two hours ago (X_SHIFT_S): a tweet read minutes after posting
// has 20 to 200 views, the same tweet two hours later has most of the
// views it will ever get, so the fetched views are attention in the same
// unit as video views (views_per_h, impressions_24h in the meta), and
// spam that nobody reads counts for little. The rate of posts in the
// hour is still the level's reading and the momentum compares it with
// the hours before, from vi_samples.
//
// The slow path owns it (hourly), but each market is read only once its
// stored reading is about three hours old: eight reads a day fit the
// daily budget, where hourly reads spent it by mid-morning UTC and left
// X dark for the rest of the day. Spend is bounded three ways: the page
// cap per market, a daily tweet budget read from the samples ledger, and
// a pause after the vendor refuses (quota, auth, rate limit). Without a
// key the source is unknown.
import { clamp, ratioToBaseline, type SourceComponent } from './score';
import { dailyLedger, pruneSamples, readSamples, writeSample } from './samples';

const API = 'https://api.twitterapi.io/twitter/tweet/advanced_search';
const WINDOW_S = 3600;
// The window ends this long before the read.
export const X_SHIFT_S = 2 * 3600;
const PAGE_SIZE = 20;
const MAX_PAGES = 3;
export const TWEET_CAP = MAX_PAGES * PAGE_SIZE;
const MAX_PHRASES = 4;
const CACHE_TTL = 50 * 60 * 1000;
// Read a market again once its reading is this old. The slack lets the
// hourly run that falls three hours later qualify despite run jitter.
export const INTERVAL_MS = 3 * 3600 * 1000;
const INTERVAL_SLACK_MS = 15 * 60 * 1000;
export const USD_PER_TWEET = 0.00015;
export const USD_PER_REQUEST_MIN = 0.00015;
// Tweets a day across all markets before the source stops for the day.
// 20k is about $3. 0 pauses the source without removing the key.
const DEFAULT_DAILY_BUDGET = 20_000;
const LEDGER_TTL = 5 * 60 * 1000;
const PAUSE_MS = 10 * 60 * 1000;
const SAMPLE_KEEP_MS = 3 * 24 * 3600 * 1000;
const MAX_SAMPLES = 40;
// Four prior reads at the three-hour interval: twelve hours of baseline.
const MIN_PRIOR_SAMPLES = 4;
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

// A full cap (60 tweets) inside this span is as fast as the estimate
// goes: 3,000 posts an hour, level ~870, the same ceiling as when the cap
// was 100 tweets over two minutes. Shorter spans are timestamp noise.
const MIN_SPAN_H = 1.2 / 60;

// Posts per hour from the fetched tweets. Under the cap the window is
// the hour and the count is the rate; at the cap the true count is
// higher, and the rate is read off the span the fetched tweets cover
// (they arrive newest first, so the oldest bounds it; `until` is the
// window's end). The span floor was a quarter hour at first, which read
// every busy market as exactly 400 an hour: Google, Bitcoin, Trump and
// Musk all filled five pages in well under fifteen minutes.
export function xRate(tweets: { createdAt: string }[], capped: boolean, until = Date.now()): number {
  if (!capped) return tweets.length;
  let oldest = until;
  for (const t of tweets) {
    const ms = Date.parse(t.createdAt);
    if (Number.isFinite(ms) && ms < oldest) oldest = ms;
  }
  const spanH = Math.max(MIN_SPAN_H, (until - oldest) / 3600_000);
  return tweets.length / spanH;
}

// Views over the fetched tweets scaled to the hour the rate describes:
// under the cap they are the hour's views; at the cap the fetched tweets
// cover only a span of it. Pure.
export function xImpressionsPerHour(views: number, tweets: number, ratePerHour: number): number {
  if (tweets === 0 || ratePerHour <= 0) return 0;
  return Math.round((views * ratePerHour) / tweets);
}

export interface XSample {
  sampled_at: string;
  value: number;
}

// This read's rate against the mean of the prior samples in the last
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
  const until = Math.floor(now / 1000) - X_SHIFT_S;
  const or = phrases.length === 1 ? phrases[0] : `(${phrases.join(' OR ')})`;
  return `${or} since_time:${until - WINDOW_S} until_time:${until} -filter:retweets`;
}

async function budgetLeft(): Promise<number> {
  const budget = xDailyBudget();
  if (budget === 0) return 0;
  if (!ledger || Date.now() - ledger.at > LEDGER_TTL) {
    // Own-account reads (lib/creators/x-account.ts) come out of the same
    // daily tweet budget.
    const [talk, own] = await Promise.all([dailyLedger('x', 'tweets'), dailyLedger('x_account', 'tweets')]);
    ledger = { spent: talk + own, at: Date.now() };
    spentThisProcess = 0;
  }
  return budget - ledger.spent - spentThisProcess;
}

export interface XRequest {
  term: string;
  aliases?: string[];
  marketId?: string | null;
  // The market's stored X reading. While it is younger than the interval
  // the source is not asked, and the caller keeps the stored reading.
  stored?: SourceComponent | null;
}

// Whether a stored reading is still current at the three-hour interval.
export function xReadingCurrent(stored: SourceComponent | null | undefined, now = Date.now()): boolean {
  if (!stored || stored.level === null) return false;
  const at = Date.parse(stored.fetchedAt);
  return Number.isFinite(at) && now - at < INTERVAL_MS - INTERVAL_SLACK_MS;
}

export async function fetchXSignal({ term, aliases = [], marketId, stored }: XRequest): Promise<SourceComponent | null> {
  const key = `${marketId ?? ''}|${term.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiry) return hit.data;
  if (xReadingCurrent(stored)) return null;

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

    const rate = xRate(tweets, capped, now - X_SHIFT_S * 1000);
    const views = tweets.reduce((s, t) => s + (t.viewCount ?? 0), 0);
    const likes = tweets.reduce((s, t) => s + (t.likeCount ?? 0), 0);
    const viewsPerHour = xImpressionsPerHour(views, tweets.length, rate);
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
        views_per_h: viewsPerHour,
        impressions_24h: viewsPerHour * 24,
        window_until: new Date(now - X_SHIFT_S * 1000).toISOString(),
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
