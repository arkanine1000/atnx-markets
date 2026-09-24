import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { scoreTerms, type ScoreRequest, type SignalResult } from '@/lib/signals';
import { recordVi } from '@/lib/store';
import { gdeltPaused } from '@/lib/vi/gdelt';
import type { Components } from '@/lib/vi/score';
import { normalizeSearchTerm } from '@/lib/vi/trends';

// Fast refresh, every 5 minutes (vercel.json). Re-reads the fast sources
// (Google Trends, Bluesky) for every live market, combines them with the
// stored slow-source readings, and appends a smoothed point to vi_history.
// The hourly sibling in ../refresh-slow owns GDELT and Wikipedia.
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Bluesky calls per market run in parallel across this many markets.
// Trends batches four markets per request on its own.
const CONCURRENCY = 8;

// The slow path scores a few markets at a time and writes each group as
// soon as it resolves, so a run that hits its time limit keeps what it
// has. GDELT is serialised at one call per 5 s whatever the group size;
// the group only lets the Wikipedia calls overlap the wait.
const SLOW_CHUNK = 4;
// No GDELT request starts after this; the reading is then unknown and
// the stored one is kept. No new group starts after the hard budget.
// Both sit inside the slow route's maxDuration (800 s) with room for the
// last group's GDELT calls and the thumbnail pass.
const SLOW_GDELT_BUDGET_MS = 480_000;
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
  // Slow path: markets whose GDELT reading was fetched this run, kept
  // from an earlier one, or not attempted because the source is paused.
  gdelt?: { fresh: number; kept: number; paused: boolean };
  dryRun?: { name: string; oldVi: number | null; raw: number | null; fetched: string[]; components: Components }[];
}

interface MarketRow {
  id: string;
  entity_name: string;
  entity_type: string | null;
  aliases: string[] | null;
  vi_components: Components | null;
  current_vi: number | null;
}

function toRequest(m: MarketRow): ScoreRequest {
  return {
    term: normalizeSearchTerm({ name: m.entity_name }),
    aliases: m.aliases ?? [],
    stored: m.vi_components ?? null,
    entityType: m.entity_type,
  };
}

// A failed GDELT fetch is stored as an unknown reading with the time it
// failed, which is not a reading at all: those markets sort first.
function gdeltAge(m: MarketRow): number {
  const g = m.vi_components?.gdelt;
  return g && g.level !== null ? Date.parse(g.fetchedAt) : 0;
}

export async function refreshScores(cadence: 'fast' | 'slow', { dryRun = false, limit }: RefreshOptions = {}): Promise<RefreshSummary> {
  const t0 = Date.now();
  const supabase = createAdminClient();
  const { data, error } = await supabase
    .from('markets')
    .select('id, entity_name, entity_type, aliases, vi_components, current_vi')
    .is('deleted_at', null);
  if (error) throw new Error(error.message);
  let markets = (data ?? []) as unknown as MarketRow[];
  if (cadence === 'slow') markets = [...markets].sort((a, b) => gdeltAge(a) - gdeltAge(b));
  if (limit !== undefined) markets = markets.slice(0, Math.max(0, limit));

  const summary: RefreshSummary = { cadence, refreshed: 0, skipped: 0, total: markets.length, elapsedMs: 0 };
  if (dryRun) summary.dryRun = [];
  if (cadence === 'slow') summary.gdelt = { fresh: 0, kept: 0, paused: gdeltPaused() };
  if (markets.length === 0) return summary;

  const chunkSize = cadence === 'fast' ? CONCURRENCY : SLOW_CHUNK;
  const gdeltDeadline = cadence === 'slow' ? t0 + SLOW_GDELT_BUDGET_MS : undefined;

  for (let i = 0; i < markets.length; i += chunkSize) {
    if (cadence === 'slow' && Date.now() - t0 > SLOW_HARD_BUDGET_MS) {
      console.error(`[markets/refresh:slow] out of time after ${i} of ${markets.length} markets`);
      summary.skipped += markets.length - i;
      break;
    }
    const chunk = markets.slice(i, i + chunkSize);
    const results = await scoreTerms(chunk.map(toRequest), cadence, { gdeltDeadline });
    await Promise.all(chunk.map((market, k) => settle(market, results[k], cadence, dryRun, summary)));
  }

  summary.elapsedMs = Date.now() - t0;
  return summary;
}

async function settle(market: MarketRow, result: SignalResult, cadence: 'fast' | 'slow', dryRun: boolean, summary: RefreshSummary) {
  if (summary.gdelt) {
    if (result.fetched.includes('gdelt')) summary.gdelt.fresh++;
    else if (result.components.gdelt?.level != null) summary.gdelt.kept++;
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
    await recordVi(market.id, result.score, result.components, []);
    summary.refreshed++;
  } catch (err) {
    console.error(`[markets/refresh:${cadence}] ${market.entity_name} failed:`, err);
    summary.skipped++;
  }
}
