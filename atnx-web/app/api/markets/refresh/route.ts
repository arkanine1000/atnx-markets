import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { scoreTerms } from '@/lib/signals';
import { recordVi } from '@/lib/store';
import type { Components } from '@/lib/vi/score';

// Fast refresh, every 5 minutes (vercel.json). Re-reads the fast sources
// (Google Trends, Bluesky) for every live market, combines them with the
// stored slow-source readings, and appends a smoothed point to vi_history.
// The hourly sibling in ../refresh-slow owns GDELT and Wikipedia.
export const dynamic = 'force-dynamic';
export const maxDuration = 120;

// Bluesky calls per market run in parallel across this many markets.
// Trends batches four markets per request on its own.
const CONCURRENCY = 8;

export async function GET(request: Request) {
  return runRefresh(request, 'fast');
}

export async function runRefresh(request: Request, cadence: 'fast' | 'slow') {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();
  const { data: markets, error } = await supabase
    .from('markets')
    .select('id, entity_name, aliases, vi_components')
    .is('deleted_at', null);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!markets || markets.length === 0) {
    return NextResponse.json({ cadence, refreshed: 0, skipped: 0, total: 0 });
  }

  let refreshed = 0;
  let skipped = 0;
  const batchSize = cadence === 'fast' ? CONCURRENCY : markets.length;

  for (let i = 0; i < markets.length; i += batchSize) {
    const batch = markets.slice(i, i + batchSize);
    const results = await scoreTerms(
      batch.map((m) => ({
        term: m.entity_name,
        aliases: (m.aliases as string[] | null) ?? [],
        stored: (m.vi_components as Components | null) ?? null,
      })),
      cadence
    );
    await Promise.all(
      batch.map(async (market, k) => {
        const result = results[k];
        try {
          // Null means no source knows the term right now. Keep the last
          // value rather than writing a zero.
          if (result.score === null) {
            skipped++;
            return;
          }
          await recordVi(market.id, result.score, result.components, []);
          refreshed++;
        } catch (err) {
          console.error(`[markets/refresh:${cadence}] ${market.entity_name} failed:`, err);
          skipped++;
        }
      })
    );
  }

  return NextResponse.json({ cadence, refreshed, skipped, total: markets.length });
}
