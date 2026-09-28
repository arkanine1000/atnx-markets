import { NextResponse } from 'next/server';
import { authorized, refreshScores } from '../refresh/route';
import { pruneComponentHistory } from '@/lib/store';
import { runXResolverPass } from '@/lib/creators/store';
import { runXAccountJob } from '@/lib/creators/x-account';
import { refreshThumbnails } from '@/lib/thumbnails';
import { describeMarkets } from '@/lib/describe';
import { sweepExpiredDrafts } from '@/lib/review';
import { runGdeltJob } from '@/lib/vi/gdelt';
import { runChannelJob } from '@/lib/creators/channel';
import { runResolverPass } from '@/lib/creators/store';

// Slow refresh, hourly (vercel.json): the quota-bound and daily sources
// (GDELT, Wikipedia, YouTube, HN, X, TikTok). It first runs the GDELT
// count on BigQuery (lib/vi/gdelt.ts), which writes the samples the
// scoring pass then reads. The scoring pass stops starting markets after
// ~10.5 minutes (../refresh/route.ts), writing each group of markets as
// it goes, so a run that runs out of time keeps what it has.
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

  // GDELT counts before scoring, so this run reads this hour's samples. A
  // failed count leaves the earlier samples, which the reading still uses
  // until they are two days old.
  let gdelt: Record<string, unknown>;
  try {
    gdelt = { ...(await runGdeltJob()) };
  } catch (err) {
    console.error('[gdelt] job failed:', err);
    gdelt = { error: (err as Error).message };
  }

  // Person markets' own YouTube channels: look up the unchecked and the
  // week-old (lib/creators/store.ts), then read every verified channel's
  // view total (lib/creators/channel.ts). Both before scoring.
  let channels: Record<string, unknown>;
  try {
    const resolver = await runResolverPass();
    channels = { resolver, ...(await runChannelJob()) };
  } catch (err) {
    console.error('[creators] channel job failed:', err);
    channels = { error: (err as Error).message };
  }
  // People's and brands' own X accounts: resolve the unchecked, then read
  // every verified account's own reach (lib/creators/x-account.ts).
  let xAccounts: Record<string, unknown>;
  try {
    const resolver = await runXResolverPass();
    xAccounts = { resolver, ...(await runXAccountJob()) };
  } catch (err) {
    console.error('[creators:x] account job failed:', err);
    xAccounts = { error: (err as Error).message };
  }

  const [scores, thumbs, described] = await Promise.allSettled([refreshScores('slow', { limit }), refreshThumbnails(), describeMarkets()]);
  // Component snapshots older than 60 days (supabase/020).
  const componentHistory = await pruneComponentHistory();

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
  // Descriptions for markets the image job does not curate (lib/describe.ts).
  let descriptions: Record<string, unknown>;
  if (described.status === 'fulfilled') {
    const { log, ...rest } = described.value;
    if (log.length) console.log('[describe]', log.join('; '));
    descriptions = rest;
  } else {
    console.error('[describe] pass failed:', described.reason);
    descriptions = { error: (described.reason as Error).message };
  }

  if (scores.status === 'rejected') {
    return NextResponse.json({ error: (scores.reason as Error).message, gdeltJob: gdelt, channelJob: channels, xAccounts, thumbnails, descriptions, drafts, componentHistory }, { status: 500 });
  }
  return NextResponse.json({ ...scores.value, gdeltJob: gdelt, channelJob: channels, xAccounts, thumbnails, descriptions, drafts, componentHistory });
}
