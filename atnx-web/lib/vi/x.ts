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
import { clamp, median, ratioToBaseline, type SourceComponent } from './score';
import { dailyLedger, pruneSamples, readSamples, writeSample } from './samples';
import { jevMode } from '../jev';
import { jevTweetVerdicts } from './relevance-x-jev';

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

export interface Tweet {
  id: string;
  createdAt: string;
  text?: string;
  lang?: string;
  isReply?: boolean;
  author?: { userName?: string; name?: string };
  viewCount?: number;
  likeCount?: number;
  retweetCount?: number;
  replyCount?: number;
  retweeted_tweet?: unknown;
}

// The read a keep-set would give: the kept posts, their share of the
// fetched ones, and the rate and views they carry. Under the cap the kept
// count is the hour's rate; at the cap the read's rate scales by the kept
// share, since the fetched posts sample the hour. Pure.
export function applyTweetVerdicts(tweets: Tweet[], keep: Set<string>, rate: number, capped: boolean) {
  const kept = tweets.filter((t) => keep.has(t.id));
  const share = tweets.length === 0 ? 0 : kept.length / tweets.length;
  return {
    kept,
    share,
    rate: capped ? rate * share : kept.length,
    views: kept.reduce((s, t) => s + (t.viewCount ?? 0), 0),
    likes: kept.reduce((s, t) => s + (t.likeCount ?? 0), 0),
  };
}

// Once reads are filtered (JEV_TWEETS=on) the earlier unfiltered ones
// carry the noise the filter removes, so a filtered read compares itself
// only with filtered samples: the day's impressions median and the
// momentum baseline restart from the switch. An unfiltered read (the
// judge failed) keeps comparing with everything. Pure.
export function comparableSamples(samples: XSample[], filtered: boolean): XSample[] {
  return filtered ? samples.filter((s) => Number(s.meta?.filtered) === 1) : samples;
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

// One hour every three is a thin sample of a day: MrBeast's rate read 164
// then 45 posts an hour, Musk's impressions 5.3M then 0.8M a day. The
// level's impressions are the median over the last day's reads (the
// current one included); the newest read alone still drives the momentum.
// Samples newest first, each with meta {views, tweets} and value = rate. Pure.
export function medianImpressionsPerHour(samples: XSample[], current: number, now = Date.now()): number {
  const vals = [current];
  for (const s of samples) {
    const age = now - Date.parse(s.sampled_at);
    if (!(age > 30 * 60 * 1000 && age <= BASELINE_MS)) continue;
    const m = s.meta ?? {};
    const views = Number(m.views), tweets = Number(m.tweets);
    if (!Number.isFinite(views) || !Number.isFinite(tweets)) continue;
    vals.push(xImpressionsPerHour(views, tweets, Number(s.value)));
  }
  return Math.round(median(vals));
}

export interface XSample {
  sampled_at: string;
  value: number;
  meta?: Record<string, string | number | boolean | null> | null;
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
  entityType?: string | null;
  category?: string | null;
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

export async function fetchXSignal({ term, aliases = [], marketId, stored, entityType, category }: XRequest): Promise<SourceComponent | null> {
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

    let counted = tweets;
    let rate = xRate(tweets, capped, now - X_SHIFT_S * 1000);
    let views = tweets.reduce((s, t) => s + (t.viewCount ?? 0), 0);
    let likes = tweets.reduce((s, t) => s + (t.likeCount ?? 0), 0);
    // Shadow pilot: Jev judges each fetched post; the verdict and the
    // reading it would give are kept beside the unfiltered numbers
    // (component meta, vi_samples x_tweet_shadow). JEV_TWEETS=on makes the
    // kept posts the ones that count.
    let filtered = false;
    let jevMeta: Record<string, string | number | null> = {};
    const mode = jevMode(process.env.JEV_TWEETS);
    if (mode !== 'off' && tweets.length > 0) {
      const jv = await jevTweetVerdicts(
        { name: term, aliases, entityType, category },
        tweets.map((t) => ({ id: t.id, text: t.text ?? '', lang: t.lang, author: t.author?.userName, isReply: t.isReply }))
      );
      if (jv) {
        const v = applyTweetVerdicts(tweets, new Set(jv.keep), rate, capped);
        const dropped = tweets.filter((t) => !jv.keep.includes(t.id));
        const line = (t: Tweet) => `${t.id}|${jv.probabilities[t.id]}|${t.lang ?? '-'}|${(t.text ?? '').replace(/\s+/g, ' ').slice(0, 80)}`;
        jevMeta = {
          jev_tweets: 'ok',
          jev_keep: v.kept.length,
          jev_drop: dropped.length,
          jev_keep_share: Math.round(v.share * 1000) / 1000,
          rate_per_h_jev: Number(v.rate.toFixed(2)),
          views_per_h_jev: xImpressionsPerHour(v.views, v.kept.length, v.rate),
          jev_ms: jv.latency_ms,
          jev_model: jv.model,
        };
        if (marketId) {
          await writeSample(marketId, 'x_tweet_shadow', dropped.length, {
            tweets: tweets.length,
            keep: v.kept.length,
            keep_share: Math.round(v.share * 1000) / 1000,
            capped: capped ? 1 : 0,
            rate: Number(rate.toFixed(2)),
            rate_jev: Number(v.rate.toFixed(2)),
            views_all: views,
            views_kept: v.views,
            dropped: dropped.map(line).join(' ;; '),
            unsure: v.kept.filter((t) => jv.probabilities[t.id] < 0.7).map(line).join(' ;; '),
            jev_model: jv.model,
            jev_ms: jv.latency_ms,
          });
        }
        if (mode === 'on') {
          counted = v.kept;
          rate = v.rate;
          views = v.views;
          likes = v.likes;
          filtered = true;
        }
      } else jevMeta = { jev_tweets: 'failed' };
    }

    const viewsPerHourRead = xImpressionsPerHour(views, counted.length, rate);
    let viewsPerHour = viewsPerHourRead;
    let momentum: number | null = null;
    if (marketId) {
      await writeSample(marketId, 'x', rate, { tweets: counted.length, requests, capped, views, likes, filtered: filtered ? 1 : 0 });
      const samples = comparableSamples(await readSamples(marketId, 'x', MAX_SAMPLES), filtered);
      momentum = xMomentum(samples, rate, now);
      viewsPerHour = medianImpressionsPerHour(samples, viewsPerHourRead, now);
      await pruneSamples(marketId, 'x', SAMPLE_KEEP_MS);
    }

    const result: SourceComponent = {
      source: 'x',
      level: xLevel(rate * 24),
      momentum,
      fetchedAt: new Date().toISOString(),
      meta: {
        posts_1h: capped ? `${Math.round(rate)}+` : counted.length,
        rate_per_h: Number(rate.toFixed(2)),
        tweets: counted.length,
        requests,
        capped: capped ? 1 : 0,
        views,
        likes,
        views_per_h: viewsPerHour,
        views_per_h_read: viewsPerHourRead,
        impressions_24h: viewsPerHour * 24,
        window_until: new Date(now - X_SHIFT_S * 1000).toISOString(),
        phrases: Math.min(MAX_PHRASES, 1 + aliases.length),
        ...(filtered ? { filtered: 1 } : {}),
        ...jevMeta,
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
