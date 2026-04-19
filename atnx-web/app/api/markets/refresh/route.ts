import { NextResponse } from 'next/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { fetchTrendsData } from '@/lib/trends';
import { recordVi } from '@/lib/store';

// Vercel cron calls this endpoint every 5 minutes (see vercel.json). It
// re-fetches Google Trends for every live market, applies a small jitter so
// identical GT values still show micro-movement, and appends a new vi_history
// row via the same write path captures use.
export const dynamic = 'force-dynamic';
export const maxDuration = 60;

// ±1.5% uniform jitter. Just enough to make the sparkline breathe between
// Google Trends refreshes — not so much that it drowns real movement.
const JITTER_PCT = 0.015;

// Keep Google Trends happy. Too many parallel calls get rate-limited fast.
const CONCURRENCY = 4;

function applyJitter(score: number): number {
  const jitter = 1 + (Math.random() * 2 - 1) * JITTER_PCT;
  return Math.max(0, Math.min(10_000, Math.round(score * jitter)));
}

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  const auth = request.headers.get('authorization');
  if (!secret || auth !== `Bearer ${secret}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  const supabase = createAdminClient();
  const { data: markets, error } = await supabase
    .from('markets')
    .select('id, entity_name, current_vi')
    .is('deleted_at', null);
  if (error) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
  if (!markets || markets.length === 0) {
    return NextResponse.json({ refreshed: 0, skipped: 0, total: 0 });
  }

  let refreshed = 0;
  let skipped = 0;

  for (let i = 0; i < markets.length; i += CONCURRENCY) {
    const batch = markets.slice(i, i + CONCURRENCY);
    const results = await Promise.all(
      batch.map(async (market) => {
        try {
          const trends = await fetchTrendsData(market.entity_name);
          // viralityScore === 0 means Google Trends gave us nothing useful
          // (rate-limited, unknown term, etc.). Skip rather than tank the
          // market's VI to zero.
          if (!trends || trends.viralityScore === 0) {
            return false;
          }
          const nextVi = applyJitter(trends.viralityScore);
          // Pass [] so recordVi doesn't re-seed vi_history — we only want
          // the fresh point appended.
          await recordVi(market.id, nextVi, []);
          return true;
        } catch (err) {
          console.error(
            `[markets/refresh] ${market.entity_name} failed:`,
            err
          );
          return false;
        }
      })
    );
    refreshed += results.filter(Boolean).length;
    skipped += results.filter((r) => !r).length;
  }

  return NextResponse.json({
    refreshed,
    skipped,
    total: markets.length,
  });
}
