// Creator reach on YouTube: a verified channel's own audience, for markets
// whose name nobody writes (lib/creators/resolve.ts finds the channel).
//
// The reading is the channel's view growth over the last week, on the same
// scale as the name-search YouTube source (youtubeLevel), from its total
// view count sampled hourly (channels.list, 50 channels per call, 1 unit).
// YouTube refreshes channel totals in steps of hours to a day, not live,
// so growth is measured across at least a day of samples; until a channel
// has that, the week's views on its recent uploads stand in (playlistItems
// and videos.list, 2 units, at most every 6 hours). Momentum is the latest
// complete day's growth against the days before it.
import { createAdminClient } from '@/lib/supabase/admin';
import { readSamples, writeSample, type Sample } from '@/lib/vi/samples';
import { ratioToBaseline, type SourceComponent } from '@/lib/vi/score';
import { youtubeConfigured, youtubeLevel } from '@/lib/vi/youtube';

const API = 'https://www.googleapis.com/youtube/v3';
const HOUR = 3600 * 1000;
const DAY = 24 * HOUR;
const WEEK = 7 * DAY;
// Growth needs this much history between the first and last total.
const MIN_SPAN = 20 * HOUR;
const BOOTSTRAP_EVERY = 6 * HOUR;
const BOOTSTRAP_MAX_AGE = DAY;
const MIN_PRIOR_DAYS = 3;
const SAMPLE_LIMIT = 250;
export const SOURCE = 'yt_channel';

export interface ChannelReading {
  level: number | null;
  momentum: number | null;
  views7d: number | null;
  basis: 'growth' | 'recent_uploads' | null;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// From a channel's samples (any order). Pure.
export function channelReading(samples: Sample[], now = Date.now()): ChannelReading {
  const none: ChannelReading = { level: null, momentum: null, views7d: null, basis: null };
  const totals = samples
    .filter((s) => s.meta?.kind === 'total' && Number.isFinite(Number(s.value)))
    .map((s) => ({ t: Date.parse(s.sampled_at), v: Number(s.value) }))
    .filter((p) => p.t <= now && now - p.t <= WEEK + DAY)
    .sort((a, b) => a.t - b.t);
  const last = totals[totals.length - 1];

  if (last && now - last.t <= 2 * DAY) {
    const inWeek = totals.filter((p) => p.t >= now - WEEK);
    const first = inWeek[0];
    const span = last.t - first.t;
    if (span >= MIN_SPAN && last.v > first.v) {
      const views7d = Math.round(((last.v - first.v) * WEEK) / span);
      // Growth per complete UTC day, from the last total seen each day.
      const endOfDay = new Map<string, number>();
      for (const p of totals) endOfDay.set(utcDay(p.t), p.v);
      const days = [...endOfDay.entries()].filter(([d]) => d < utcDay(now)).sort(([a], [b]) => (a < b ? -1 : 1));
      const growth = days.slice(1).map(([, v], i) => Math.max(0, v - days[i][1]));
      const momentum = growth.length > MIN_PRIOR_DAYS ? ratioToBaseline(growth[growth.length - 1], growth.slice(0, -1).slice(-13)) : null;
      return { level: youtubeLevel(views7d), momentum, views7d, basis: 'growth' };
    }
  }

  const boot = samples
    .filter((s) => s.meta?.kind === 'recent_uploads')
    .map((s) => ({ t: Date.parse(s.sampled_at), v: Number(s.value) }))
    .filter((p) => p.t <= now && now - p.t <= BOOTSTRAP_MAX_AGE)
    .sort((a, b) => b.t - a.t)[0];
  if (boot) return { level: youtubeLevel(boot.v), momentum: null, views7d: boot.v, basis: 'recent_uploads' };
  return none;
}

// The reading as fields on the YouTube component, so the fast path and
// the next run see it without re-reading samples.
export function channelMeta(channelId: string, r: ChannelReading): Record<string, string | number | null> {
  return { channel_id: channelId, channel_level: r.level, channel_momentum: r.momentum, channel_views_7d: r.views7d, channel_basis: r.basis };
}

// The component that scores a creator market's YouTube slot: the channel
// when it reads higher than the name search, else the name search.
export function effectiveYoutube(youtube: SourceComponent | undefined): { component: SourceComponent | undefined; channel: boolean } {
  const lvl = youtube?.meta?.channel_level;
  if (!youtube || typeof lvl !== 'number' || lvl <= (youtube.level ?? 0)) return { component: youtube, channel: false };
  const mom = youtube.meta?.channel_momentum;
  return { component: { ...youtube, level: lvl, momentum: typeof mom === 'number' ? mom : null }, channel: true };
}

async function api<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const res = await fetch(`${API}/${path}?${new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY ?? '' })}`, { cache: 'no-store' });
  if (!res.ok) {
    console.error(`[creators] ${path} ${res.status}: ${(await res.text()).slice(0, 120)}`);
    return null;
  }
  return (await res.json()) as T;
}

// Views in the last week on a channel's recent uploads (the bootstrap).
async function recentUploadViews(channelId: string, now: number): Promise<number | null> {
  const pl = await api<{ items?: { contentDetails?: { videoId?: string; videoPublishedAt?: string } }[] }>('playlistItems', {
    part: 'contentDetails',
    playlistId: `UU${channelId.slice(2)}`,
    maxResults: '15',
  });
  if (!pl) return null;
  const ids = (pl.items ?? [])
    .filter((i) => i.contentDetails?.videoPublishedAt && now - Date.parse(i.contentDetails.videoPublishedAt) <= WEEK)
    .map((i) => i.contentDetails!.videoId!)
    .filter(Boolean);
  if (ids.length === 0) return 0;
  const v = await api<{ items?: { statistics?: { viewCount?: string } }[] }>('videos', { part: 'statistics', id: ids.join(',') });
  if (!v) return null;
  return (v.items ?? []).reduce((a, i) => a + Number(i.statistics?.viewCount ?? 0), 0);
}

export interface CreatorHandle {
  market_id: string;
  platform_id: string;
  verified_at: string | null;
}

export async function verifiedYoutubeHandles(marketIds?: string[]): Promise<CreatorHandle[]> {
  let q = createAdminClient().from('market_handles').select('market_id, platform_id, verified_at').eq('platform', 'youtube').eq('status', 'verified');
  if (marketIds) q = q.in('market_id', marketIds);
  const { data, error } = await q;
  if (error) {
    console.error('[creators] handles', error.message);
    return [];
  }
  return ((data ?? []) as CreatorHandle[]).filter((h) => !!h.platform_id);
}

export interface ChannelJobSummary {
  channels: number;
  totals: number;
  bootstraps: number;
  units: number;
  skipped?: string;
}

// The hourly pass: every verified channel's total, one call per 50, and a
// bootstrap for channels without a day of totals yet.
export async function runChannelJob(now = Date.now()): Promise<ChannelJobSummary> {
  const summary: ChannelJobSummary = { channels: 0, totals: 0, bootstraps: 0, units: 0 };
  if (!youtubeConfigured()) return { ...summary, skipped: 'YOUTUBE_API_KEY not set' };
  const handles = await verifiedYoutubeHandles();
  summary.channels = handles.length;
  for (let i = 0; i < handles.length; i += 50) {
    const batch = handles.slice(i, i + 50);
    summary.units++;
    const body = await api<{ items?: { id: string; statistics?: { viewCount?: string; subscriberCount?: string; videoCount?: string } }[] }>('channels', {
      part: 'statistics',
      id: batch.map((h) => h.platform_id).join(','),
    });
    const byId = new Map((body?.items ?? []).map((it) => [it.id, it.statistics]));
    for (const h of batch) {
      const st = byId.get(h.platform_id);
      if (!st?.viewCount) continue;
      await writeSample(h.market_id, SOURCE, Number(st.viewCount), { kind: 'total', channel_id: h.platform_id, subscribers: Number(st.subscriberCount ?? 0), videos: Number(st.videoCount ?? 0) });
      summary.totals++;
    }
  }
  for (const h of handles) {
    const samples = await readSamples(h.market_id, SOURCE, SAMPLE_LIMIT);
    if (channelReading(samples, now).basis === 'growth') continue;
    const lastBoot = samples.find((s) => s.meta?.kind === 'recent_uploads');
    if (lastBoot && now - Date.parse(lastBoot.sampled_at) < BOOTSTRAP_EVERY) continue;
    summary.units += 2;
    const views = await recentUploadViews(h.platform_id, now);
    if (views === null) continue;
    await writeSample(h.market_id, SOURCE, views, { kind: 'recent_uploads', channel_id: h.platform_id });
    summary.bootstraps++;
  }
  return summary;
}

// The slow path's channel reading for one market, as component meta.
export async function readChannelMeta(marketId: string, channelId: string, now = Date.now()) {
  return channelMeta(channelId, channelReading(await readSamples(marketId, SOURCE, SAMPLE_LIMIT), now));
}
