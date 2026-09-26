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
import { CALIBRATION, isShortsFirst, metaNumber, ratioToBaseline, type Calibration, type SourceComponent } from '@/lib/vi/score';
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
// How often a growth-basis channel re-reads its recent uploads for the
// Shorts share (2 units), and how many uploads the share needs.
const SHORTS_EVERY = DAY;
const MIN_UPLOADS_FOR_SHARE = 5;
export const SOURCE = 'yt_channel';

export interface ChannelReading {
  level: number | null;
  momentum: number | null;
  views7d: number | null;
  basis: 'growth' | 'recent_uploads' | null;
  // Share of the recent uploads that are Shorts (<= 180 s), from the
  // newest uploads read within a week; null when unknown.
  shortsShare: number | null;
}

// ISO 8601 duration as YouTube reports it ("PT1M5S", "P0D") to seconds. Pure.
export function parseIsoDuration(s: string | null | undefined): number | null {
  if (!s) return null;
  const m = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(s.trim());
  if (!m) return null;
  return Number(m[1] ?? 0) * 86400 + Number(m[2] ?? 0) * 3600 + Number(m[3] ?? 0) * 60 + Number(m[4] ?? 0);
}

// Share of uploads at or under the Shorts length; null under
// MIN_UPLOADS_FOR_SHARE known durations. Pure.
export function shortsShare(durations: (number | null)[], cal: Calibration = CALIBRATION): number | null {
  const known = durations.filter((d): d is number => d !== null && Number.isFinite(d));
  if (known.length < MIN_UPLOADS_FOR_SHARE) return null;
  return known.filter((d) => d <= cal.shorts.maxSeconds).length / known.length;
}

// The newest Shorts share among the samples, within a week. Pure.
function latestShortsShare(samples: Sample[], now: number): number | null {
  const s = samples
    .filter((s) => typeof s.meta?.shorts_share === 'number' && Number.isFinite(s.meta.shorts_share))
    .map((s) => ({ t: Date.parse(s.sampled_at), v: s.meta!.shorts_share as number }))
    .filter((p) => p.t <= now && now - p.t <= WEEK)
    .sort((a, b) => b.t - a.t)[0];
  return s ? s.v : null;
}

const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// From a channel's samples (any order). Pure.
export function channelReading(samples: Sample[], now = Date.now()): ChannelReading {
  const shorts = latestShortsShare(samples, now);
  const none: ChannelReading = { level: null, momentum: null, views7d: null, basis: null, shortsShare: shorts };
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
      return { level: youtubeLevel(views7d), momentum, views7d, basis: 'growth', shortsShare: shorts };
    }
  }

  const boot = samples
    .filter((s) => s.meta?.kind === 'recent_uploads')
    .map((s) => ({ t: Date.parse(s.sampled_at), v: Number(s.value) }))
    .filter((p) => p.t <= now && now - p.t <= BOOTSTRAP_MAX_AGE)
    .sort((a, b) => b.t - a.t)[0];
  if (boot) return { level: youtubeLevel(boot.v), momentum: null, views7d: boot.v, basis: 'recent_uploads', shortsShare: shorts };
  return none;
}

// The reading as fields on the YouTube component, so the fast path and
// the next run see it without re-reading samples.
export function channelMeta(channelId: string, r: ChannelReading): Record<string, string | number | null> {
  return { channel_id: channelId, channel_level: r.level, channel_momentum: r.momentum, channel_views_7d: r.views7d, channel_basis: r.basis, channel_shorts_share: r.shortsShare };
}

// The component that scores a creator market's YouTube slot: the channel
// when its week of views (Shorts-discounted) beats the name search, else
// the name search. The scoring copy carries the channel's views as
// views_7d and its momentum; the stored reading is not changed.
export function effectiveYoutube(youtube: SourceComponent | undefined, cal: Calibration = CALIBRATION): { component: SourceComponent | undefined; channel: boolean } {
  const meta = youtube?.meta;
  const channel = metaNumber(meta?.channel_views_7d);
  if (!youtube || channel === null) return { component: youtube, channel: false };
  const discounted = channel * (isShortsFirst(metaNumber(meta?.channel_shorts_share), cal) ? cal.shorts.discount : 1);
  if (discounted <= (metaNumber(meta?.views_7d) ?? 0)) return { component: youtube, channel: false };
  const mom = meta?.channel_momentum;
  return {
    component: {
      ...youtube,
      level: youtubeLevel(discounted),
      momentum: typeof mom === 'number' ? mom : null,
      meta: { ...(meta ?? {}), views_7d: discounted, views_basis: 'channel' },
    },
    channel: true,
  };
}

async function api<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const res = await fetch(`${API}/${path}?${new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY ?? '' })}`, { cache: 'no-store' });
  if (!res.ok) {
    console.error(`[creators] ${path} ${res.status}: ${(await res.text()).slice(0, 120)}`);
    return null;
  }
  return (await res.json()) as T;
}

export interface UploadsProfile {
  // Views in the last week on the recent uploads (the bootstrap reading).
  views7d: number;
  shortsShare: number | null;
  uploads: number;
}

// A channel's last 15 uploads: the week's views on them and the share of
// Shorts among them (playlistItems and videos.list, 2 units).
async function uploadsProfile(channelId: string, now: number): Promise<UploadsProfile | null> {
  const pl = await api<{ items?: { contentDetails?: { videoId?: string; videoPublishedAt?: string } }[] }>('playlistItems', {
    part: 'contentDetails',
    playlistId: `UU${channelId.slice(2)}`,
    maxResults: '15',
  });
  if (!pl) return null;
  const published = new Map<string, number>();
  for (const i of pl.items ?? []) {
    const id = i.contentDetails?.videoId;
    if (id) published.set(id, Date.parse(i.contentDetails?.videoPublishedAt ?? '') || 0);
  }
  if (published.size === 0) return { views7d: 0, shortsShare: null, uploads: 0 };
  const v = await api<{ items?: { id: string; statistics?: { viewCount?: string }; contentDetails?: { duration?: string } }[] }>('videos', {
    part: 'statistics,contentDetails',
    id: [...published.keys()].join(','),
  });
  if (!v) return null;
  const items = v.items ?? [];
  const views7d = items
    .filter((i) => now - (published.get(i.id) ?? 0) <= WEEK)
    .reduce((a, i) => a + Number(i.statistics?.viewCount ?? 0), 0);
  return { views7d, shortsShare: shortsShare(items.map((i) => parseIsoDuration(i.contentDetails?.duration))), uploads: items.length };
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
  // Daily Shorts-share reads on channels already on the growth basis.
  profiles: number;
  units: number;
  skipped?: string;
}

// The hourly pass: every verified channel's total, one call per 50, and a
// bootstrap for channels without a day of totals yet.
export async function runChannelJob(now = Date.now(), marketIds?: string[]): Promise<ChannelJobSummary> {
  const summary: ChannelJobSummary = { channels: 0, totals: 0, bootstraps: 0, profiles: 0, units: 0 };
  if (!youtubeConfigured()) return { ...summary, skipped: 'YOUTUBE_API_KEY not set' };
  const handles = await verifiedYoutubeHandles(marketIds);
  summary.channels = handles.length;
  const videoCounts = new Map<string, number>();
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
      videoCounts.set(h.platform_id, Number(st.videoCount ?? 0));
      await writeSample(h.market_id, SOURCE, Number(st.viewCount), { kind: 'total', channel_id: h.platform_id, subscribers: Number(st.subscriberCount ?? 0), videos: Number(st.videoCount ?? 0) });
      summary.totals++;
    }
  }
  for (const h of handles) {
    const samples = ofChannel(await readSamples(h.market_id, SOURCE, SAMPLE_LIMIT), h.platform_id);
    // A channel with no videos has no uploads playlist (404).
    if (videoCounts.get(h.platform_id) === 0) continue;
    if (channelReading(samples, now).basis === 'growth') {
      // Growth needs no bootstrap; the uploads are read once a day for the
      // Shorts share only.
      const lastShare = samples.find((s) => typeof s.meta?.shorts_share === 'number');
      if (lastShare && now - Date.parse(lastShare.sampled_at) < SHORTS_EVERY) continue;
      summary.units += 2;
      const p = await uploadsProfile(h.platform_id, now);
      if (!p) continue;
      await writeSample(h.market_id, SOURCE, p.views7d, { kind: 'shorts_share', channel_id: h.platform_id, shorts_share: p.shortsShare, uploads: p.uploads });
      summary.profiles++;
      continue;
    }
    const lastBoot = samples.find((s) => s.meta?.kind === 'recent_uploads');
    if (lastBoot && now - Date.parse(lastBoot.sampled_at) < BOOTSTRAP_EVERY) continue;
    summary.units += 2;
    const p = await uploadsProfile(h.platform_id, now);
    if (!p) continue;
    await writeSample(h.market_id, SOURCE, p.views7d, { kind: 'recent_uploads', channel_id: h.platform_id, shorts_share: p.shortsShare, uploads: p.uploads });
    summary.bootstraps++;
  }
  return summary;
}

// Only the given channel's samples: when a market's verified channel
// changes (Dolan Dark, 2026-09-26: @dolandark was abandoned for
// @dolandarkest), the old channel's totals would read as a jump of the
// difference between two channels. Pure.
export function ofChannel(samples: Sample[], channelId: string): Sample[] {
  return samples.filter((s) => s.meta?.channel_id === channelId);
}

// The slow path's channel reading for one market, as component meta.
export async function readChannelMeta(marketId: string, channelId: string, now = Date.now()) {
  return channelMeta(channelId, channelReading(ofChannel(await readSamples(marketId, SOURCE, SAMPLE_LIMIT), channelId), now));
}
