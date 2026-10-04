// Instagram as a VI source, through the Apify "instagram-hashtag-scraper"
// actor in hashtag mode with reels: the reels under the market's tag,
// each with its plays and upload time. Instagram's first name-based
// reading; before it the platform was seen only through captured posts
// (lib/vi/post.ts). Keyword search was probed on 2026-10-04 and ranks
// by relevance with no date order, so a meme's result set is its old
// viral reels; the tag's reels are recent for a busy tag and a stale mix
// for a quiet one, which a window sorts out.
//
// The reading is views a day: the plays on the reels uploaded inside the
// last week, over the week, or over the hours the page spans when the
// page is full of this week's reels. The TikTok unit (CALIBRATION in
// lib/vi/score.ts). The momentum is today's reading against the reads a
// day or two back. The tag is the one the TikTok source settled on when
// it has one (people post under the same tag on both), else the name
// squashed. Read every two days, daily when the market is hot, on the
// slow pass. One run per pass carries a few tags, runs in parallel; a run
// that fails loses only its own markets.
//
// $0.0023 a result on the Starter plan. Bounded by a daily tag budget
// from the samples ledger, a per-pass cap, and a pause after a refusal.
// Without a token the source is unknown.
import { ratioToBaseline, type SourceComponent } from './score';
import { dailyLedger, pruneSamples, readSamples, writeSample, type Sample } from './samples';
import { postLevel } from './post';
import { hashtagCandidates } from './tiktok';

const ACTOR = 'apify~instagram-hashtag-scraper';
const APIFY = 'https://api.apify.com/v2/acts';
const RUN_TIMEOUT_S = 240;
const PAUSE_MS = 30 * 60 * 1000;
const LEDGER_TTL = 5 * 60 * 1000;
const DEFAULT_RESULTS = 12;
const DEFAULT_DAILY_BUDGET = 40;
const MAX_TAGS_PER_PASS = 24;
const TAGS_PER_RUN = 6;
const PARALLEL_RUNS = 4;
const HOUR = 3600 * 1000;
export const HOT_INTERVAL_MS = 24 * HOUR;
export const INTERVAL_MS = 48 * HOUR;
const SLACK_MS = 15 * 60 * 1000;
const HOT_LEVEL = 600;
const HOT_MOMENTUM = 1.5;
export const WINDOW_H = 7 * 24;
const BASELINE_MIN_H = 20;
const BASELINE_MAX_H = 76;
const SAMPLE_KEEP_MS = 5 * 24 * HOUR;
const MAX_SAMPLES = 10;

export function instagramConfigured(): boolean {
  return Boolean(process.env.APIFY_TOKEN);
}
function envInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}
// Tags read a day across all markets; 0 pauses the source.
export const instagramDailyBudget = (): number => envInt('INSTAGRAM_DAILY_BUDGET', DEFAULT_DAILY_BUDGET);
export const resultsPerTag = (): number => Math.max(1, envInt('INSTAGRAM_RESULTS', DEFAULT_RESULTS));
export function usdPerInstagramResult(): number {
  const n = Number(process.env.APIFY_USD_PER_INSTAGRAM_RESULT);
  return Number.isFinite(n) && n > 0 ? n : 0.0023;
}

// The tag a market is read under: the TikTok mapping when there is one,
// else the name squashed. Null when nothing qualifies. Pure.
export function instagramTag(term: string, aliases: string[] = [], tiktokTag?: string | null): string | null {
  if (typeof tiktokTag === 'string' && /^[a-z0-9]{3,30}$/.test(tiktokTag)) return tiktokTag;
  return hashtagCandidates(term, aliases)[0] ?? null;
}

export interface Reel {
  id: string;
  createdAt: number; // ms
  plays: number;
}
export type Row = { inputUrl?: unknown; shortCode?: unknown; id?: unknown; timestamp?: unknown; videoPlayCount?: unknown; videoViewCount?: unknown; igPlayCount?: unknown; productType?: unknown };

function num(v: unknown): number | null {
  const n = typeof v === 'string' ? Number(v) : v;
  return typeof n === 'number' && Number.isFinite(n) && n >= 0 ? n : null;
}
// The tag a row answers, from the page it was read off. Pure.
export function rowTag(row: Row): string | null {
  const u = typeof row.inputUrl === 'string' ? row.inputUrl : '';
  const m = u.match(/\/explore\/tags\/([^/?#]+)/);
  return m ? decodeURIComponent(m[1]).toLowerCase() : null;
}
// One row as a reel; a row without a time or a play count is skipped. Pure.
export function rowToReel(row: Row): Reel | null {
  const id = typeof row.shortCode === 'string' ? row.shortCode : typeof row.id === 'string' ? row.id : '';
  const t = typeof row.timestamp === 'string' ? Date.parse(row.timestamp) : NaN;
  const plays = num(row.videoPlayCount) ?? num(row.igPlayCount) ?? num(row.videoViewCount);
  if (!id || !Number.isFinite(t) || plays === null) return null;
  return { id, createdAt: t, plays };
}

export interface InstagramReading {
  // Plays a day on the week's reels; null with no reel at all.
  viewsPerDay: number | null;
  reelsWeek: number;
  reelsDay: number;
  playsWeek: number;
  spanH: number;
  // Every returned reel is inside the week: there are more than were read.
  capped: boolean;
}

// A tag's reading from the reels its page returned (any order). Pure.
export function instagramReading(reels: Reel[], cap: number, now = Date.now()): InstagramReading {
  const seen = new Set<string>();
  const unique = reels.filter((r) => !seen.has(r.id) && seen.add(r.id) && r.createdAt <= now + HOUR);
  if (unique.length === 0) return { viewsPerDay: null, reelsWeek: 0, reelsDay: 0, playsWeek: 0, spanH: WINDOW_H, capped: false };
  const week = unique.filter((r) => now - r.createdAt < WINDOW_H * HOUR);
  const capped = unique.length >= cap && week.length === unique.length;
  const oldest = week.length ? Math.min(...week.map((r) => r.createdAt)) : now;
  const spanH = capped ? Math.max(1, (now - oldest) / HOUR) : WINDOW_H;
  const playsWeek = week.reduce((a, r) => a + r.plays, 0);
  return {
    viewsPerDay: Math.round((playsWeek / spanH) * 24),
    reelsWeek: week.length,
    reelsDay: week.filter((r) => now - r.createdAt < 24 * HOUR).length,
    playsWeek,
    spanH: Math.round(spanH * 10) / 10,
    capped,
  };
}

// Today's reading against the reads one to three days back. Pure.
export function momentumFromSamples(samples: Sample[], viewsPerDay: number, now = Date.now()): number | null {
  const prior = samples
    .filter((s) => {
      const h = (now - Date.parse(s.sampled_at)) / HOUR;
      return h >= BASELINE_MIN_H && h <= BASELINE_MAX_H && typeof s.meta?.views_per_day === 'number';
    })
    .map((s) => s.meta!.views_per_day as number);
  return prior.length === 0 ? null : ratioToBaseline(viewsPerDay, prior);
}

function hot(stored: SourceComponent | null | undefined): boolean {
  return (stored?.level ?? 0) >= HOT_LEVEL || (stored?.momentum ?? 0) >= HOT_MOMENTUM;
}
// Whether the tag is read this pass: never, two days, one when hot. Pure.
export function instagramDue(stored: SourceComponent | null | undefined, now = Date.now()): boolean {
  const at = Date.parse(stored?.fetchedAt ?? '');
  if (!Number.isFinite(at)) return true;
  return now - at >= (hot(stored) ? HOT_INTERVAL_MS : INTERVAL_MS) - SLACK_MS;
}

// --- Fetching ------------------------------------------------------------------

let pausedUntil = 0;
let ledger: { spent: number; at: number } | null = null;
let readThisProcess = 0;
let batch: Promise<Map<string, Row[]>> | null = null;
let batchStarted = 0;

async function budgetLeft(): Promise<number> {
  if (!ledger || Date.now() - ledger.at > LEDGER_TTL) {
    ledger = { spent: await dailyLedger('instagram', 'searched'), at: Date.now() };
    readThisProcess = 0;
  }
  return instagramDailyBudget() - ledger.spent - readThisProcess;
}

async function readTags(tags: string[]): Promise<Row[] | null> {
  const res = await fetch(`${APIFY}/${ACTOR}/run-sync-get-dataset-items?token=${encodeURIComponent(process.env.APIFY_TOKEN ?? '')}&timeout=${RUN_TIMEOUT_S}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ hashtags: tags, resultsType: 'reels', resultsLimit: resultsPerTag() }),
    cache: 'no-store',
    signal: AbortSignal.timeout((RUN_TIMEOUT_S + 30) * 1000),
  });
  if (!res.ok) {
    const text = (await res.text()).slice(0, 160);
    console.error(`[instagram] ${res.status}: ${text}`);
    if (!/run-failed|TIMED-OUT/.test(text)) pausedUntil = Date.now() + PAUSE_MS;
    return null;
  }
  const body = await res.json();
  return Array.isArray(body) ? (body as Row[]) : null;
}

export interface InstagramRequest {
  marketId?: string | null;
  term: string;
  aliases?: string[];
  tiktokTag?: string | null;
  stored?: SourceComponent | null;
}

// Starts the pass's runs for the markets due a read, under the day's
// budget and the pass cap. The adapters await the result. Returns how
// many tags were sent.
export function prefetchInstagram(requests: InstagramRequest[], now = Date.now()): number {
  if (!instagramConfigured() || now < pausedUntil) return 0;
  const due = requests
    .filter((r) => r.marketId && instagramDue(r.stored, now))
    .map((r) => ({ id: r.marketId as string, tag: instagramTag(r.term, r.aliases ?? [], r.tiktokTag) }))
    .filter((r): r is { id: string; tag: string } => r.tag !== null);
  if (due.length === 0) return 0;
  batchStarted = now;
  const sent = Math.min(due.length, MAX_TAGS_PER_PASS);
  batch = (async () => {
    const result = new Map<string, Row[]>();
    try {
      const left = await budgetLeft();
      const plan = due.slice(0, Math.max(0, Math.min(MAX_TAGS_PER_PASS, left)));
      if (plan.length < due.length) console.error(`[instagram] ${due.length - plan.length} of ${due.length} tags wait (budget ${instagramDailyBudget()}/day, pass cap ${MAX_TAGS_PER_PASS})`);
      const tags = [...new Set(plan.map((r) => r.tag))];
      if (tags.length === 0) return result;
      readThisProcess += tags.length;
      const chunks: string[][] = [];
      for (let i = 0; i < tags.length; i += TAGS_PER_RUN) chunks.push(tags.slice(i, i + TAGS_PER_RUN));
      const byTag = new Map<string, Row[]>();
      for (let i = 0; i < chunks.length; i += PARALLEL_RUNS) {
        const got = await Promise.all(chunks.slice(i, i + PARALLEL_RUNS).map((c) => readTags(c).catch(() => null)));
        for (const [j, rows] of got.entries()) {
          if (!rows) continue;
          for (const t of chunks[i + j]) byTag.set(t, []);
          for (const row of rows) {
            const t = rowTag(row);
            if (t !== null && byTag.has(t)) byTag.get(t)!.push(row);
          }
        }
      }
      for (const r of plan) {
        const rows = byTag.get(r.tag);
        if (rows) result.set(r.id, rows);
      }
    } catch (err) {
      console.error(`[instagram] batch failed: ${(err as Error).message}`);
    }
    return result;
  })();
  return sent;
}

export async function fetchInstagramSignal(req: InstagramRequest): Promise<SourceComponent | null> {
  const { marketId, stored } = req;
  const now = Date.now();
  if (!marketId) return null;
  if (!instagramConfigured()) return { source: 'instagram', level: null, momentum: null, fetchedAt: new Date(now).toISOString() };
  if (!instagramDue(stored, now)) return stored ?? null;
  if (!batch || now - batchStarted > 20 * 60 * 1000) return stored ?? null; // not in this pass's run
  const rows = (await batch).get(marketId);
  if (!rows) return stored ?? null; // beyond the caps or the run failed
  const tag = instagramTag(req.term, req.aliases ?? [], req.tiktokTag) ?? '';
  const reading = instagramReading(rows.map(rowToReel).filter((r): r is Reel => r !== null), resultsPerTag(), now);
  const prior = await readSamples(marketId, 'instagram', MAX_SAMPLES);
  const viewsPerDay = reading.viewsPerDay ?? 0;
  const momentum = momentumFromSamples(prior, viewsPerDay, now);
  await writeSample(marketId, 'instagram', viewsPerDay, {
    tag,
    views_per_day: viewsPerDay,
    reels_week: reading.reelsWeek,
    reels_day: reading.reelsDay,
    plays_week: reading.playsWeek,
    span_h: reading.spanH,
    capped: reading.capped ? 1 : 0,
    results: rows.length,
    searched: 1,
  });
  await pruneSamples(marketId, 'instagram', SAMPLE_KEEP_MS);
  const firstReadAt = typeof stored?.meta?.first_read_at === 'string' ? stored.meta.first_read_at : new Date(now).toISOString();
  return {
    source: 'instagram',
    // A tag with no reel this week is a known 0.
    level: postLevel(viewsPerDay),
    momentum,
    fetchedAt: new Date(now).toISOString(),
    meta: {
      tag,
      views_per_day: viewsPerDay,
      reels_week: reading.reelsWeek,
      reels_day: reading.reelsDay,
      plays_week: reading.playsWeek,
      span_h: reading.spanH,
      capped: reading.capped ? 1 : 0,
      results: rows.length,
      first_read_at: firstReadAt,
    },
  };
}
