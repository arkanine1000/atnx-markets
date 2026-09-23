import { NextResponse } from 'next/server';
import { runRefresh } from '../refresh/route';
import { refreshThumbnails } from '@/lib/thumbnails';
import { sweepExpiredDrafts } from '@/lib/review';

// Slow refresh, hourly (vercel.json): GDELT news volume and Wikipedia
// pageviews, both daily-resolution sources that also rate-limit hard.
// GDELT calls are serialised at one per 5 s, so this route needs the
// long budget: 200 markets is ~17 minutes.
//
// Once the scores are in, the same run sweeps expired review drafts and
// curates images for the highlighted
// markets that still show a raw capture (lib/thumbnails.ts). That step is
// bounded per run and its failure never fails the refresh.
export const dynamic = 'force-dynamic';
export const maxDuration = 800;

export async function GET(request: Request) {
  const res = await runRefresh(request, 'slow');
  if (!res.ok) return res;
  const body = (await res.json()) as Record<string, unknown>;

  // Review-step drafts nobody committed: mark them expired and drop the
  // parked images (lib/review.ts). Never fails the refresh.
  let drafts: Record<string, unknown>;
  try {
    drafts = await sweepExpiredDrafts();
  } catch (err) {
    console.error('[drafts] sweep failed:', err);
    drafts = { error: (err as Error).message };
  }

  try {
    const { log, ...thumbnails } = await refreshThumbnails();
    if (log.length) console.log('[thumbnails]', log.join('; '));
    return NextResponse.json({ ...body, thumbnails, drafts });
  } catch (err) {
    console.error('[thumbnails] pass failed:', err);
    return NextResponse.json({ ...body, thumbnails: { error: (err as Error).message }, drafts });
  }
}
