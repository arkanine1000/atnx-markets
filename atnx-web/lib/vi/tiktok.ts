// TikTok as a VI source, through the Apify "tiktok-hashtag-stats" actor:
// the cumulative number of videos under a hashtag, sampled and
// differenced. TikTok has no keyword search we can afford, so a market
// is tracked by the hashtag people actually post under, found once from
// the name and aliases (letters and digits, "skibiditoilet") and
// confirmed by the actor's counts, then re-checked weekly.
//
// One actor run per pass carries every market's hashtag(s), up to the
// Free plan's fifty rows: the dispatcher starts it before the markets are
// scored (prefetchTiktok) and each market reads its row from the batch.
// The sample is the cumulative count; the reading is its growth rate on a
// daily axis (see tiktokReading: a trend with a spike gate, because the
// vendor's totals jitter), and the momentum is that rate against the
// prior day's trend. Sampled every three hours
// (the stored reading is returned unchanged until then). Views are
// recorded but not scored: TikTok stopped showing hashtag views in 2024
// and the vendor's figure is of uncertain origin.
//
// $0.0005 per hashtag plus compute. Bounded by the rows-per-run cap, a
// daily hashtag budget from the samples ledger, and a pause after a
// failed run. Without a token the source is unknown.
import { clamp, median, ratioToBaseline, type SourceComponent } from './score';
import { dailyLedger, pruneSamples, readSamples, writeSample, type Sample } from './samples';

const ACTOR = 'funny_ground~tiktok-hashtag-stats';
const API = `https://api.apify.com/v2/acts/${ACTOR}/run-sync-get-dataset-items`;
const RUN_TIMEOUT_S = 240;
// The actor now and then leaves a hashtag out of its results: a tag we
// know has 10k videos comes back as no row at all. Those are asked once
// more in a short second run. A tag that does not exist (or is banned)
// is missing again and costs nothing.
const RETRY_TIMEOUT_S = 90;
export const MAX_ROWS_PER_RUN = 50;
export const INTERVAL_MS = 3 * 3600 * 1000;
// A reading is written minutes into the run (:07 start, :10 write), so
// three hours later it is still a few minutes short of the interval and
// the read slipped to four hours. The slack lets that run take it.
const INTERVAL_SLACK_MS = 15 * 60 * 1000;
const DISCOVERY_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_CANDIDATES = 4;
// A hashtag with fewer videos than this is not where the market lives.
const MIN_VIDEOS = 100;
const DEFAULT_DAILY_BUDGET = 400;
const PAUSE_MS = 30 * 60 * 1000;
const SAMPLE_KEEP_MS = 3 * 24 * 3600 * 1000;
const MAX_SAMPLES = 30;
// Two samples this far apart bound one growth reading.
const MIN_GAP_H = 1;
const MAX_GAP_H = 9;
// The level's trend covers this much history before the newest read...
const TREND_WINDOW_H = 12;
// ...and needs this many earlier reads in it; until then the newest pair.
const MIN_TREND_READS = 3;
// Momentum compares with the trend of the prior day, from this many reads.
const BASELINE_WINDOW_H = 30;
const MIN_BASELINE_READS = 5;
// A newest pair this many noise-widths above the trend is a real spike
// and is taken as it is; anything less is read off the trend.
const SPIKE_K = 3;
export const USD_PER_HASHTAG = 0.0005;

export interface HashtagStats {
  hashtag: string;
  video_count: number;
  view_count: number | null;
}

let pausedUntil = 0;
// The run in flight for this pass, keyed by lower-cased hashtag.
let batch: Promise<Map<string, HashtagStats>> | null = null;
let batchStarted = 0;

export function tiktokConfigured(): boolean {
  return !!process.env.APIFY_TOKEN;
}

export function tiktokDailyBudget(): number {
  const raw = process.env.TIKTOK_DAILY_HASHTAG_BUDGET;
  if (raw === undefined || raw === '') return DEFAULT_DAILY_BUDGET;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_DAILY_BUDGET;
}

// Videos a day to level, log scale, the same axis as X:
//   10/day -> 100, 100 -> 300, 1k -> 500, 10k -> 700, 100k -> 900
export function tiktokLevel(videos24h: number): number {
  if (videos24h < 1) return 0;
  return clamp(Math.round(100 + 200 * Math.log10(Math.max(videos24h, 10) / 10)));
}

// Hashtags a market might be posted under: the name and each alias with
// everything but letters and digits removed, the name first. No single
// word of a longer name: "elizabeth" is not a market. Pure.
export function hashtagCandidates(term: string, aliases: string[] = []): string[] {
  const out: string[] = [];
  const push = (s: string) => {
    const tag = s.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (tag.length >= 3 && tag.length <= 30 && !out.includes(tag)) out.push(tag);
  };
  push(term);
  for (const a of aliases) push(a);
  return out.slice(0, MAX_CANDIDATES);
}

// A name's own tag with this many videos is the market's over a bigger
// but broader alias tag ("elonmusk" over "elon")...
const OWN_TAG_MIN_VIDEOS = 10 * MIN_VIDEOS;
// ...unless an alias tag is this many times bigger: then the alias is
// what people actually post under ("gta6" at millions against
// "grandtheftautovi" at 17k).
const ALIAS_OVER_OWN = 20;

// The hashtag the market lives under, from a batch of counts: the name's
// own tag when it is established and no alias tag dwarfs it, otherwise
// the candidate with the most videos, if it has enough. Pure.
export function pickHashtag(candidates: string[], counts: Map<string, HashtagStats>): HashtagStats | null {
  const own = candidates[0] ? counts.get(candidates[0].toLowerCase()) : undefined;
  let best: HashtagStats | null = null;
  for (const c of candidates) {
    const s = counts.get(c.toLowerCase());
    if (s && s.video_count >= MIN_VIDEOS && (!best || s.video_count > best.video_count)) best = s;
  }
  if (own && own.video_count >= OWN_TAG_MIN_VIDEOS && (!best || best.video_count < ALIAS_OVER_OWN * own.video_count)) return own;
  return best;
}

export interface TiktokReading {
  level: number | null;
  momentum: number | null;
  videosPerHour: number | null;
}

export interface TrendFit {
  slope: number; // videos per hour
  noise: number; // robust spread of the counts around the line, in videos
}

// Theil-Sen line through (hours, count) points: the median of the pairwise
// slopes, which a stale total or two cannot drag, and the robust sigma
// (1.4826 x MAD) of the residuals. Needs two points. Pure.
export function trendFit(points: { h: number; v: number }[]): TrendFit {
  const slopes: number[] = [];
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      const dh = points[j].h - points[i].h;
      if (dh !== 0) slopes.push((points[j].v - points[i].v) / dh);
    }
  }
  const slope = median(slopes);
  const intercept = median(points.map((p) => p.v - slope * p.h));
  const noise = 1.4826 * median(points.map((p) => Math.abs(p.v - (intercept + slope * p.h))));
  return { slope, noise };
}

// The growth rate of the current hashtag. The vendor's cumulative totals
// jitter by about 0.01-0.02 % between reads and sometimes step back to an
// older value, which on a slow tag swamps three hours of real growth: pair
// deltas read 0 one read and double the next. So:
//   - the rate is the Theil-Sen trend over the last TREND_WINDOW_H;
//   - unless the newest pair rises above the trend of the earlier reads by
//     more than SPIKE_K times their noise: a real spike shows on its first
//     read, as with plain pairs. Drops only come through the trend.
//   - until enough reads exist, the newest pair.
// Momentum is the rate against the trend of the prior day, and only when
// the gap clears the same noise band; within it the source says nothing.
// Samples newest first, the current one included. Pure.
export function tiktokReading(samples: Sample[], now = Date.now()): TiktokReading {
  const none = { level: null, momentum: null, videosPerHour: null };
  const tag = samples[0]?.meta?.hashtag;
  if (!tag) return none;

  // The current hashtag's unbroken run, oldest first, reads at least
  // MIN_GAP_H apart (an off-cycle read next to a scheduled one is dropped).
  const run: { h: number; v: number }[] = [];
  for (const smp of samples) {
    if (smp.meta?.hashtag !== tag) break;
    const h = Date.parse(smp.sampled_at) / 3600_000;
    const v = Number(smp.value);
    if (!Number.isFinite(h) || !Number.isFinite(v)) continue;
    const newer = run[0];
    if (newer && newer.h - h < MIN_GAP_H) continue;
    if (newer && newer.h - h > MAX_GAP_H) break;
    if (run.length && run[run.length - 1].h - h > BASELINE_WINDOW_H) break;
    run.unshift({ h, v });
  }
  if (run.length < 2) return none;
  const last = run[run.length - 1];
  const prev = run[run.length - 2];
  if (now / 3600_000 - last.h > MAX_GAP_H) return none;

  const pair = Math.max(0, (last.v - prev.v) / (last.h - prev.h));
  const earlier = run.slice(0, -1);
  const recent = earlier.filter((p) => last.h - p.h <= TREND_WINDOW_H + 0.5);

  let rate = pair;
  if (recent.length >= MIN_TREND_READS) {
    const base = trendFit(recent);
    const band = (SPIKE_K * Math.SQRT2 * Math.max(base.noise, 1)) / (last.h - prev.h);
    if (pair <= Math.max(0, base.slope) + band) {
      rate = Math.max(0, trendFit([...recent, last]).slope);
    }
  }

  let momentum: number | null = null;
  if (earlier.length >= MIN_BASELINE_READS) {
    const day = trendFit(earlier);
    const dayBand = (SPIKE_K * Math.SQRT2 * Math.max(day.noise, 1)) / (last.h - prev.h);
    const baseline = Math.max(0, day.slope);
    if (Math.abs(rate - baseline) > dayBand) momentum = ratioToBaseline(rate, [baseline]);
  }

  return { level: tiktokLevel(rate * 24), momentum, videosPerHour: Number(rate.toFixed(2)) };
}

export interface TiktokRequest {
  term: string;
  aliases?: string[];
  marketId?: string | null;
  stored?: SourceComponent | null;
}

// The hashtags a market needs counted this pass: none while its reading
// is fresh; its mapped hashtag when the mapping is recent; otherwise
// every candidate, to (re)discover the mapping. Pure.
export function hashtagsWanted({ term, aliases = [], stored }: TiktokRequest, now = Date.now()): string[] {
  const fetchedAt = stored?.fetchedAt ? Date.parse(stored.fetchedAt) : 0;
  const hasMapping = typeof stored?.meta?.hashtag === 'string' && stored.meta.hashtag.length > 0;
  if (stored && now - fetchedAt < INTERVAL_MS - INTERVAL_SLACK_MS && (hasMapping || stored.meta?.hashtag === null)) return [];
  const discoveredAt = typeof stored?.meta?.discovered_at === 'string' ? Date.parse(stored.meta.discovered_at) : 0;
  if (hasMapping && now - discoveredAt < DISCOVERY_TTL_MS) return [stored!.meta!.hashtag as string];
  return hashtagCandidates(term, aliases);
}

// Starts the pass's one actor run for these markets' hashtags. Mapped
// markets first, then candidates for unmapped ones, up to the row cap;
// the rest wait for the next pass. Returns how many hashtags were sent.
export function prefetchTiktok(requests: TiktokRequest[], now = Date.now()): number {
  if (!tiktokConfigured() || now < pausedUntil) return 0;
  const mapped: string[] = [];
  const discovering: string[][] = [];
  for (const r of requests) {
    const wanted = hashtagsWanted(r, now);
    if (wanted.length === 1 && wanted[0] === r.stored?.meta?.hashtag) mapped.push(wanted[0]);
    else if (wanted.length > 0) discovering.push(wanted);
  }
  const tags = new Set<string>(mapped.map((t) => t.toLowerCase()));
  for (const group of discovering) {
    if (tags.size + group.length > MAX_ROWS_PER_RUN) continue;
    for (const t of group) tags.add(t.toLowerCase());
  }
  if (tags.size === 0) return 0;
  batchStarted = now;
  batch = runActor([...tags]);
  return tags.size;
}

async function runActor(hashtags: string[]): Promise<Map<string, HashtagStats>> {
  const out = new Map<string, HashtagStats>();
  try {
    const budget = tiktokDailyBudget();
    const spent = await dailyLedger('tiktok', 'queried');
    if (budget - spent < hashtags.length) {
      console.error(`[tiktok] daily hashtag budget reached (${spent}/${budget}); skipping run`);
      return out;
    }
    if (!(await callActor(hashtags, RUN_TIMEOUT_S, out))) return out;
    const missing = hashtags.filter((t) => !out.has(t.toLowerCase()));
    if (missing.length > 0 && budget - spent - out.size >= missing.length) {
      await callActor(missing, RETRY_TIMEOUT_S, out);
    }
  } catch (err) {
    console.error(`[tiktok] actor run failed: ${(err as Error).message}`);
    pausedUntil = Date.now() + PAUSE_MS;
  }
  return out;
}

// One actor run; its rows are added to `out`. False when the vendor
// refused, which also pauses the source.
async function callActor(hashtags: string[], timeoutS: number, out: Map<string, HashtagStats>): Promise<boolean> {
  const res = await fetch(`${API}?token=${encodeURIComponent(process.env.APIFY_TOKEN ?? '')}&timeout=${timeoutS}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashtags, maxConcurrency: 4 }),
    cache: 'no-store',
    signal: AbortSignal.timeout((timeoutS + 30) * 1000),
  });
  if (!res.ok) {
    console.error(`[tiktok] actor ${res.status}: ${(await res.text()).slice(0, 160)}`);
    pausedUntil = Date.now() + PAUSE_MS;
    return false;
  }
  const items = (await res.json()) as { hashtag?: string; video_count?: number; view_count?: number; error?: unknown }[];
  for (const it of items) {
    if (!it.hashtag || it.error || typeof it.video_count !== 'number') continue;
    out.set(it.hashtag.toLowerCase(), { hashtag: it.hashtag.toLowerCase(), video_count: it.video_count, view_count: typeof it.view_count === 'number' ? it.view_count : null });
  }
  return true;
}

// On a re-discovery, a market whose current hashtag got no row this pass
// keeps it rather than being re-mapped on partial counts; it asks again
// next pass. Pure.
export function holdMapping(wanted: string[], stored: SourceComponent | null | undefined, counts: Map<string, HashtagStats>): boolean {
  const mapped = typeof stored?.meta?.hashtag === 'string' ? stored.meta.hashtag.toLowerCase() : null;
  if (!mapped || wanted.length <= 1) return false;
  return wanted.some((t) => t.toLowerCase() === mapped) && !counts.has(mapped);
}

export async function fetchTiktokSignal(req: TiktokRequest): Promise<SourceComponent> {
  const { marketId, stored } = req;
  const now = Date.now();
  const empty: SourceComponent = { source: 'tiktok', level: null, momentum: null, fetchedAt: new Date().toISOString() };
  if (!tiktokConfigured()) return empty;
  const wanted = hashtagsWanted(req, now);
  // Fresh enough: the stored reading stands, and stays marked as stored.
  if (wanted.length === 0) return stored ?? empty;
  if (!batch || now - batchStarted > 20 * 60 * 1000) return stored ?? empty; // not in this pass's run

  const counts = await batch;
  if (holdMapping(wanted, stored, counts)) return stored ?? empty;
  const stats = pickHashtag(wanted, counts);
  const discovering = wanted.length > 1 || wanted[0] !== stored?.meta?.hashtag;
  const queried = wanted.filter((t) => counts.has(t.toLowerCase())).length;
  if (queried === 0) return stored ?? empty; // beyond the row cap this pass, or the run failed
  const discoveredAt = discovering ? new Date(now).toISOString() : ((stored?.meta?.discovered_at as string | null) ?? new Date(now).toISOString());

  if (!stats) {
    // No hashtag with enough videos under any name: unknown, not zero
    // (a hashtag is not the phrase), remembered for a week.
    if (marketId) await writeSample(marketId, 'tiktok', 0, { hashtag: null, queried, view_count: null });
    return { ...empty, meta: { hashtag: null, discovered_at: discoveredAt, queried } };
  }

  let reading: TiktokReading = { level: null, momentum: null, videosPerHour: null };
  if (marketId) {
    await writeSample(marketId, 'tiktok', stats.video_count, { hashtag: stats.hashtag, queried, view_count: stats.view_count });
    reading = tiktokReading(await readSamples(marketId, 'tiktok', MAX_SAMPLES), now);
    await pruneSamples(marketId, 'tiktok', SAMPLE_KEEP_MS);
  }
  return {
    source: 'tiktok',
    level: reading.level,
    momentum: reading.momentum,
    fetchedAt: new Date(now).toISOString(),
    meta: {
      hashtag: stats.hashtag,
      discovered_at: discoveredAt,
      videos_total: stats.video_count,
      views_total: stats.view_count,
      videos_per_h: reading.videosPerHour,
      queried,
    },
  };
}
