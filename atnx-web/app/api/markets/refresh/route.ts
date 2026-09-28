import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { prefetchSlowSources, scoreTerms, type ScoreRequest, type SignalResult, creatorOf } from '@/lib/signals';
import { recordVi } from '@/lib/store';
import { xSpendUsd } from '@/lib/vi/x';
import { usdPerHashtag } from '@/lib/vi/tiktok';
import type { Components } from '@/lib/vi/score';
import { normalizeSearchTerm } from '@/lib/vi/trends';
import { verifiedYoutubeHandles, type CreatorHandle } from '@/lib/creators/channel';
import { verifiedXHandles, type XHandle } from '@/lib/creators/x-account';

// Fast refresh, every 5 minutes (vercel.json). Re-reads the fast sources
// (Google Trends, Bluesky) for every live market, combines them with the
// stored slow-source readings, and appends a smoothed point to vi_history.
// The hourly sibling in ../refresh-slow owns the slow sources (GDELT,
// Wikipedia, YouTube, HN, X, TikTok).
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Bluesky calls per market run in parallel across this many markets.
// Trends batches four markets per request on its own.
const CONCURRENCY = 8;

// The slow path scores a few markets at a time and writes each group as
// soon as it resolves, so a run that hits its time limit keeps what it
// has. No new group starts after the hard budget, which sits inside the
// slow route's maxDuration (800 s) with room for the thumbnail pass.
const SLOW_CHUNK = 4;
const SLOW_HARD_BUDGET_MS = 640_000;

export async function GET(request: Request) {
  return runRefresh(request, 'fast');
}

export function authorized(request: Request): boolean {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  return !!secret && auth === `Bearer ${secret}`;
}

export async function runRefresh(request: Request, cadence: 'fast' | 'slow') {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  try {
    return NextResponse.json(await refreshScores(cadence));
  } catch (err) {
    return NextResponse.json({ error: (err as Error).message }, { status: 500 });
  }
}

export interface RefreshOptions {
  // Score but write nothing; the summary then carries each market's
  // breakdown. For checking a deploy against production data.
  dryRun?: boolean;
  // Only this many markets (stalest first on the slow path).
  limit?: number;
}

export interface RefreshSummary {
  cadence: 'fast' | 'slow';
  refreshed: number;
  skipped: number;
  total: number;
  elapsedMs: number;
  // Slow path: markets with a GDELT reading from the samples, and those
  // still unknown (no history yet, or the job has fallen behind).
  gdelt?: { known: number; unknown: number };
  // Slow path: what the paid X source fetched and roughly cost this run.
  x?: { markets: number; tweets: number; requests: number; estUsd: number };
  // Slow path: hashtags sent to the TikTok actor this run, markets read.
  tiktok?: { hashtags: number; markets: number; estUsd: number };
  dryRun?: { name: string; oldVi: number | null; raw: number | null; fetched: string[]; components: Components }[];
}

interface MarketRow {
  id: string;
  entity_name: string;
  entity_type: string | null;
  category: string | null;
  aliases: string[] | null;
  description: string | null;
  vi_components: Components | null;
  current_vi: number | null;
}

function toRequest(m: MarketRow, handle?: CreatorHandle, x?: XHandle): ScoreRequest {
  return {
    term: normalizeSearchTerm({ name: m.entity_name }),
    aliases: m.aliases ?? [],
    stored: m.vi_components ?? null,
    entityType: m.entity_type,
    category: m.category,
    description: m.description,
    marketId: m.id,
    creator: creatorOf(handle, x),
  };
}

export async function refreshScores(cadence: 'fast' | 'slow', { dryRun = false, limit }: RefreshOptions = {}): Promise<RefreshSummary> {
  const t0 = Date.now();
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('markets')
    .select('id, entity_name, entity_type, category, aliases, description, vi_components, current_vi')
    .is('deleted_at', null);
  if (error) throw new Error(error.message);
  let markets = (data ?? []) as unknown as MarketRow[];
  if (limit !== undefined) markets = markets.slice(0, Math.max(0, limit));

  const summary: RefreshSummary = { cadence, refreshed: 0, skipped: 0, total: markets.length, elapsedMs: 0 };
  if (dryRun) summary.dryRun = [];
  if (cadence === 'slow') {
    summary.gdelt = { known: 0, unknown: 0 };
    summary.x = { markets: 0, tweets: 0, requests: 0, estUsd: 0 };
    summary.tiktok = { hashtags: 0, markets: 0, estUsd: 0 };
  }
  if (markets.length === 0) return summary;
  const ids = markets.map((m) => m.id);
  const [yt, xs] = await Promise.all([verifiedYoutubeHandles(ids), verifiedXHandles(ids)]);
  const handles = new Map(yt.map((h) => [h.market_id, h]));
  const xHandles = new Map(xs.map((h) => [h.market_id, h]));
  const request = (m: MarketRow) => toRequest(m, handles.get(m.id), xHandles.get(m.id));

  if (cadence === 'slow' && summary.tiktok) {
    const started = prefetchSlowSources(markets.map(request));
    summary.tiktok.hashtags = started.tiktokHashtags;
    summary.tiktok.estUsd = Number((started.tiktokHashtags * usdPerHashtag()).toFixed(4));
  }

  const chunkSize = cadence === 'fast' ? CONCURRENCY : SLOW_CHUNK;

  for (let i = 0; i < markets.length; i += chunkSize) {
    if (cadence === 'slow' && Date.now() - t0 > SLOW_HARD_BUDGET_MS) {
      console.error(`[markets/refresh:slow] out of time after ${i} of ${markets.length} markets`);
      summary.skipped += markets.length - i;
      break;
    }
    const chunk = markets.slice(i, i + chunkSize);
    const results = await scoreTerms(chunk.map(request), cadence);
    await Promise.all(chunk.map((market, k) => settle(market, results[k], cadence, dryRun, summary, t0)));
  }

  summary.elapsedMs = Date.now() - t0;
  return summary;
}

async function settle(market: MarketRow, result: SignalResult, cadence: 'fast' | 'slow', dryRun: boolean, summary: RefreshSummary, startedAt: number) {
  if (summary.gdelt) {
    if (result.components.gdelt?.level != null) summary.gdelt.known++;
    else if (result.components.gdelt) summary.gdelt.unknown++;
  }
  // A TikTok market counts when its row was read this run, even on the
  // first sample, which has a mapping but no level yet.
  const tiktokAt = result.components.tiktok?.fetchedAt ? Date.parse(result.components.tiktok.fetchedAt) : 0;
  if (summary.tiktok && tiktokAt >= startedAt) summary.tiktok.markets++;
  if (summary.x && result.fetched.includes('x')) {
    const meta = result.components.x?.meta ?? {};
    const reading = { tweets: Number(meta.tweets ?? 0), requests: Number(meta.requests ?? 0) };
    summary.x.markets++;
    summary.x.tweets += reading.tweets;
    summary.x.requests += reading.requests;
    summary.x.estUsd = Number((summary.x.estUsd + xSpendUsd([reading])).toFixed(4));
  }
  if (dryRun) {
    summary.dryRun!.push({ name: market.entity_name, oldVi: market.current_vi, raw: result.score, fetched: result.fetched, components: result.components });
    summary.refreshed++;
    return;
  }
  try {
    // Null means no source knows the term right now. Keep the last
    // value rather than writing a zero.
    if (result.score === null) {
      summary.skipped++;
      return;
    }
    // A slow pass reads every source: a market still scoring goes live.
    await recordVi(market.id, result.score, result.components, [], { fullPass: cadence === 'slow' });
    summary.refreshed++;
  } catch (err) {
    console.error(`[markets/refresh:${cadence}] ${market.entity_name} failed:`, err);
    summary.skipped++;
  }
}
