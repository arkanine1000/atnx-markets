import { NextResponse } from 'next/server';
import { authorized, refreshScores } from '../refresh/route';
import { refreshThumbnails } from '@/lib/thumbnails';
import { sweepExpiredDrafts } from '@/lib/review';

// Slow refresh, hourly (vercel.json): GDELT news volume and Wikipedia
// pageviews, both daily-resolution sources that also rate-limit hard.
// GDELT calls are serialised at one per 5 s, so this route needs the
// long budget: 52 markets is about 4.5 minutes when GDELT answers, and
// the scoring pass stops asking GDELT after 8 minutes and stops starting
// markets after ~10.5 (../refresh/route.ts), writing each group of
// markets as it goes, so a run that runs out of time keeps what it has.
//
// The same run sweeps expired review drafts first and curates images
// for highlighted markets that still show a raw capture
// (lib/thumbnails.ts) alongside the scores, so a long scoring pass cannot
// starve it. Neither step's failure fails the refresh.
//
// `?dry=1&limit=N` scores the N stalest markets and writes nothing, for
// checking a deploy against production data; the sweep and the
// thumbnails are skipped too.
export const dynamic = 'force-dynamic';
export const maxDuration = 800;

export async function GET(request: Request) {
  if (!authorized(request)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }
  const url = new URL(request.url);
  const dryRun = url.searchParams.get('dry') === '1';
  const limitParam = url.searchParams.get('limit');
  const limit = limitParam !== null && /^\d+$/.test(limitParam) ? Number(limitParam) : undefined;

  if (dryRun) {
    try {
      return NextResponse.json(await refreshScores('slow', { dryRun: true, limit }));
    } catch (err) {
      return NextResponse.json({ error: (err as Error).message }, { status: 500 });
    }
  }

  // Review-step drafts nobody committed: mark them expired and drop the
  // parked images (lib/review.ts).
  let drafts: Record<string, unknown>;
  try {
    drafts = await sweepExpiredDrafts();
  } catch (err) {
    console.error('[drafts] sweep failed:', err);
    drafts = { error: (err as Error).message };
  }

  const [scores, thumbs] = await Promise.allSettled([refreshScores('slow', { limit }), refreshThumbnails()]);

  if (scores.status === 'rejected') {
    console.error('[markets/refresh:slow] failed:', scores.reason);
  }
  let thumbnails: Record<string, unknown>;
  if (thumbs.status === 'fulfilled') {
    const { log, ...rest } = thumbs.value;
    if (log.length) console.log('[thumbnails]', log.join('; '));
    thumbnails = rest;
  } else {
    console.error('[thumbnails] pass failed:', thumbs.reason);
    thumbnails = { error: (thumbs.reason as Error).message };
  }

  if (scores.status === 'rejected') {
    return NextResponse.json({ error: (scores.reason as Error).message, thumbnails, drafts }, { status: 500 });
  }
  return NextResponse.json({ ...scores.value, thumbnails, drafts });
}
