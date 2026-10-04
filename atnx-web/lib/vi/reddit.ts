// Reddit as a VI source, through the Apify "harshmaur/reddit-scraper"
// actor: the newest posts naming the phrase, with their upvotes and
// comment counts. Reddit is where memes are argued over, games and
// politics discussed and tech announced; none of the other sources sees
// it. The first undone item of the 2026-09-26 brainstorm, affordable
// since the Apify Starter plan (2026-10-04).
//
// One actor run per pass carries every due market's phrases as search
// terms (the name in quotes, so Reddit matches the phrase and not any of
// its words, plus up to two multi-word aliases); rows come back tagged
// with the term they answer. Sorted newest first inside the last week,
// RESULTS posts a phrase: a quiet phrase returns its whole week, a busy
// one the newest RESULTS, and the reading is taken over the hours those
// posts span. The reading is engagement a day, upvotes plus comments on
// the week's posts (a Reddit post is worth more than a Bluesky one, so
// posts a day would under-read it; see CALIBRATION in lib/vi/score.ts),
// and the momentum is today's post rate against the week's daily
// average, or against the rate of the prior reads a day back once there
// are some. Read once a day on the slow pass.
//
// $0.0018 a result on the Starter plan plus $0.02 a run. Bounded by a
// daily phrase budget from the samples ledger, a per-run cap, and a pause
// after a refusal. Without a token the source is unknown.
import { clamp, ratioToBaseline, type SourceComponent } from './score';
import { dailyLedger, pruneSamples, readSamples, writeSample, type Sample } from './samples';

const ACTOR = 'harshmaur~reddit-scraper';
const APIFY = 'https://api.apify.com/v2/acts';
const RUN_TIMEOUT_S = 150;
const PAUSE_MS = 30 * 60 * 1000;
const LEDGER_TTL = 5 * 60 * 1000;
const DEFAULT_RESULTS = 10;
const DEFAULT_DAILY_BUDGET = 80;
// One run a pass; the first day's reads spread over passes through this.
const MAX_PHRASES_PER_RUN = 30;
export const MAX_PHRASES = 3;
const HOUR = 3600 * 1000;
export const INTERVAL_MS = 24 * HOUR;
const SLACK_MS = 15 * 60 * 1000;
export const WINDOW_H = 7 * 24;
// Momentum from samples: the rate this long ago.
const BASELINE_MIN_H = 20;
const BASELINE_MAX_H = 52;
const SAMPLE_KEEP_MS = 4 * 24 * HOUR;
const MAX_SAMPLES = 10;

export function redditConfigured(): boolean {
  return Boolean(process.env.APIFY_TOKEN);
}

function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
// Phrases searched a day across all markets; 0 pauses the source.
export const redditDailyBudget = (): number => envInt('REDDIT_DAILY_BUDGET', DEFAULT_DAILY_BUDGET);
export const resultsPerPhrase = (): number => Math.max(1, envInt('REDDIT_RESULTS', DEFAULT_RESULTS));
// What one result costs, for the refresh summary and vi:report.
export function usdPerRedditResult(): number {
  const n = Number(process.env.APIFY_USD_PER_REDDIT_RESULT);
  return Number.isFinite(n) && n > 0 ? n : 0.0018;
}
export const USD_PER_REDDIT_RUN = 0.02;

// Engagement a day to level, log scale:
//   0 -> 0, 1 -> 100, 10 -> 300, 100 -> 500, 1k -> 700, 10k -> 900
export function redditLevel(engagementPerDay: number): number {
  if (engagementPerDay < 1) return 0;
  return clamp(Math.round(100 + 200 * Math.log10(engagementPerDay)));
}

// The search terms for a market: the name quoted, then multi-word
// aliases quoted (a one-word alias matches too much of Reddit). Pure.
export function redditPhrases(term: string, aliases: string[] = []): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of [term, ...aliases]) {
    const p = raw.trim().replace(/"/g, '');
    if (p.length < 2 || seen.has(p.toLowerCase())) continue;
    if (out.length > 0 && !/\s/.test(p)) continue;
    seen.add(p.toLowerCase());
    out.push(`"${p}"`);
    if (out.length >= MAX_PHRASES) break;
  }
  return out;
}

export interface RedditPost {
  id: string;
  createdAt: number; // ms
  upvotes: number;
  comments: number;
}

export type Row = { id?: unknown; searchTerm?: unknown; dataType?: unknown; createdAt?: unknown; upVotes?: unknown; score?: unknown; commentsCount?: unknown };

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) ? n : null;
}

// One actor row as a post; comments and rows without a time are skipped. Pure.
export function rowToPost(row: Row): RedditPost | null {
  if (row.dataType !== undefined && row.dataType !== 'post') return null;
  const id = typeof row.id === 'string' ? row.id : '';
  const t = typeof row.createdAt === 'string' ? Date.parse(row.createdAt) : NaN;
  if (!id || !Number.isFinite(t)) return null;
  return { id, createdAt: t, upvotes: Math.max(0, num(row.upVotes) ?? num(row.score) ?? 0), comments: Math.max(0, num(row.commentsCount) ?? 0) };
}

const fold = (q: string) => q.replace(/"/g, '').trim().toLowerCase();

// Rows by the phrase they answer, every asked phrase present. Pure.
export function groupByPhrase(rows: Row[], phrases: string[]): Map<string, Row[]> {
  const out = new Map<string, Row[]>(phrases.map((p) => [p, []]));
  const byFolded = new Map(phrases.map((p) => [fold(p), p]));
  for (const row of rows) {
    const p = typeof row.searchTerm === 'string' ? byFolded.get(fold(row.searchTerm)) : undefined;
    if (p !== undefined) out.get(p)!.push(row);
  }
  return out;
}

export interface RedditReading {
  // Upvotes plus comments a day on the week's posts; null with no posts.
  engagementPerDay: number | null;
  // Posts a day, over the day or over the span when capped.
  postsPerDay: number;
  postsDay: number;
  postsWeek: number;
  engagementWeek: number;
  // Hours the newest RESULTS posts span; the window when not capped.
  spanH: number;
  // The page filled up: the week has more posts than were read.
  capped: boolean;
  // Today's post rate against the week's daily average, when the week
  // was read in full; null when capped (today is all there is).
  momentum: number | null;
}

// A market's reading from the posts its phrases returned (de-duplicated
// across phrases), newest first or not. Pure.
export function redditReading(posts: RedditPost[], cap: number, now = Date.now()): RedditReading {
  const seen = new Set<string>();
  const week = posts.filter((p) => !seen.has(p.id) && seen.add(p.id) && now - p.createdAt < WINDOW_H * HOUR && p.createdAt <= now + HOUR);
  if (week.length === 0) return { engagementPerDay: null, postsPerDay: 0, postsDay: 0, postsWeek: 0, engagementWeek: 0, spanH: WINDOW_H, capped: false, momentum: null };
  const oldest = Math.min(...week.map((p) => p.createdAt));
  // One phrase at its cap means the week was cut; the span is what was read.
  const capped = posts.length >= cap && now - oldest < WINDOW_H * HOUR;
  const spanH = capped ? Math.max(1, (now - oldest) / HOUR) : WINDOW_H;
  const engagementWeek = week.reduce((a, p) => a + p.upvotes + p.comments, 0);
  const postsDay = week.filter((p) => now - p.createdAt < 24 * HOUR).length;
  const engagementPerDay = Math.round((engagementWeek / spanH) * 24);
  const postsPerDay = capped ? (week.length / spanH) * 24 : postsDay;
  const momentum = capped ? null : ratioToBaseline(postsDay, [week.length / 7]);
  return { engagementPerDay, postsPerDay: Math.round(postsPerDay * 100) / 100, postsDay, postsWeek: week.length, engagementWeek, spanH: Math.round(spanH * 10) / 10, capped, momentum };
}

// Momentum from the stored reads: today's post rate against the rates a
// day or two back. Null without a prior read in that window. Pure.
export function momentumFromSamples(samples: Sample[], postsPerDay: number, now = Date.now()): number | null {
  const prior = samples
    .filter((s) => {
      const h = (now - Date.parse(s.sampled_at)) / HOUR;
      return h >= BASELINE_MIN_H && h <= BASELINE_MAX_H && typeof s.meta?.posts_per_day === 'number';
    })
    .map((s) => s.meta!.posts_per_day as number);
  return prior.length === 0 ? null : ratioToBaseline(postsPerDay, prior);
}

// Whether the market is read this pass: never, or a day since. Pure.
export function redditDue(stored: SourceComponent | null | undefined, now = Date.now()): boolean {
  const at = Date.parse(stored?.fetchedAt ?? '');
  return !Number.isFinite(at) || now - at >= INTERVAL_MS - SLACK_MS;
}

// --- Fetching ------------------------------------------------------------------

let pausedUntil = 0;
let ledger: { spent: number; at: number } | null = null;
let searchedThisProcess = 0;
let batch: Promise<Map<string, { rows: Row[]; phrases: string[] }>> | null = null;
let batchStarted = 0;

async function budgetLeft(): Promise<number> {
  if (!ledger || Date.now() - ledger.at > LEDGER_TTL) {
    ledger = { spent: await dailyLedger('reddit', 'searched'), at: Date.now() };
    searchedThisProcess = 0;
  }
  return redditDailyBudget() - ledger.spent - searchedThisProcess;
}

async function search(phrases: string[]): Promise<Row[] | null> {
  const res = await fetch(`${APIFY}/${ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(process.env.APIFY_TOKEN ?? '')}&timeout=${RUN_TIMEOUT_S}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ searchTerms: phrases, searchPosts: true, searchComments: false, searchCommunities: false, searchSort: 'new', searchTime: 'week', maxPostsCount: resultsPerPhrase(), fastMode: true, includeNSFW: false }),
    cache: 'no-store',
    signal: AbortSignal.timeout((RUN_TIMEOUT_S + 30) * 1000),
  });
  if (!res.ok) {
    console.error(`[reddit] ${res.status}: ${(await res.text()).slice(0, 160)}`);
    pausedUntil = Date.now() + PAUSE_MS;
    return null;
  }
  const body = await res.json();
  return Array.isArray(body) ? (body as Row[]) : null;
}

export interface RedditRequest {
  marketId?: string | null;
  term: string;
  aliases?: string[];
  stored?: SourceComponent | null;
}

// Starts the pass's one run for the markets due a read, under the day's
// budget and the run cap. The adapters await the result. Returns how
// many phrases were sent.
export function prefetchReddit(requests: RedditRequest[], now = Date.now()): number {
  if (!redditConfigured() || now < pausedUntil) return 0;
  const due = requests.filter((r) => r.marketId && redditDue(r.stored, now)).map((r) => ({ id: r.marketId as string, phrases: redditPhrases(r.term, r.aliases ?? []) })).filter((r) => r.phrases.length > 0);
  if (due.length === 0) return 0;
  batchStarted = now;
  let sent = 0;
  const plan: typeof due = [];
  batch = (async () => {
    const result = new Map<string, { rows: Row[]; phrases: string[] }>();
    try {
      const left = await budgetLeft();
      let room = Math.max(0, Math.min(MAX_PHRASES_PER_RUN, left));
      for (const r of due) {
        if (r.phrases.length > room) continue;
        plan.push(r);
        room -= r.phrases.length;
      }
      if (plan.length < due.length) console.error(`[reddit] ${due.length - plan.length} of ${due.length} markets wait (budget ${redditDailyBudget()} phrases/day, run cap ${MAX_PHRASES_PER_RUN})`);
      const phrases = [...new Set(plan.flatMap((r) => r.phrases))];
      if (phrases.length === 0) return result;
      searchedThisProcess += phrases.length;
      sent = phrases.length;
      const rows = await search(phrases);
      if (!rows) return result;
      const grouped = groupByPhrase(rows, phrases);
      for (const r of plan) result.set(r.id, { rows: r.phrases.flatMap((p) => grouped.get(p) ?? []), phrases: r.phrases });
    } catch (err) {
      console.error(`[reddit] batch failed: ${(err as Error).message}`);
    }
    return result;
  })();
  return sent || Math.min(due.reduce((a, r) => a + r.phrases.length, 0), MAX_PHRASES_PER_RUN);
}

export async function fetchRedditSignal(req: RedditRequest): Promise<SourceComponent | null> {
  const { marketId, stored } = req;
  const now = Date.now();
  if (!marketId) return null;
  if (!redditConfigured()) return { source: 'reddit', level: null, momentum: null, fetchedAt: new Date(now).toISOString() };
  if (!redditDue(stored, now)) return stored ?? null;
  if (!batch || now - batchStarted > 20 * 60 * 1000) return stored ?? null; // not in this pass's run
  const mine = (await batch).get(marketId);
  if (!mine) return stored ?? null; // beyond the caps or the run failed

  const posts = mine.rows.map(rowToPost).filter((p): p is RedditPost => p !== null);
  const cap = resultsPerPhrase() * mine.phrases.length;
  const reading = redditReading(posts, cap, now);
  const prior = await readSamples(marketId, 'reddit', MAX_SAMPLES);
  const momentum = momentumFromSamples(prior, reading.postsPerDay, now) ?? reading.momentum;
  await writeSample(marketId, 'reddit', reading.engagementPerDay ?? 0, {
    posts_per_day: reading.postsPerDay,
    posts_day: reading.postsDay,
    posts_week: reading.postsWeek,
    engagement_week: reading.engagementWeek,
    span_h: reading.spanH,
    capped: reading.capped ? 1 : 0,
    results: mine.rows.length,
    searched: mine.phrases.length,
  });
  await pruneSamples(marketId, 'reddit', SAMPLE_KEEP_MS);
  const firstReadAt = typeof stored?.meta?.first_read_at === 'string' ? stored.meta.first_read_at : new Date(now).toISOString();
  return {
    source: 'reddit',
    // A week with no post is a known 0.
    level: redditLevel(reading.engagementPerDay ?? 0),
    momentum,
    fetchedAt: new Date(now).toISOString(),
    meta: {
      engagement_per_day: reading.engagementPerDay ?? 0,
      posts_per_day: reading.postsPerDay,
      posts_day: reading.postsDay,
      posts_week: reading.postsWeek,
      engagement_week: reading.engagementWeek,
      span_h: reading.spanH,
      capped: reading.capped ? 1 : 0,
      results: mine.rows.length,
      phrases: mine.phrases.join(' '),
      first_read_at: firstReadAt,
    },
  };
}
