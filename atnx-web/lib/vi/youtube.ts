// YouTube Data API v3 as a VI source. Free, but search.list has its own
// bucket of 100 calls a day (since 2026-06), so discovery is rationed: a
// search per market finds the most-viewed videos of the last week for the
// name, repeated every one to three days depending on how the market is
// moving (see discoveryInterval), and the hourly pass re-reads their view
// counts with videos.list (1 unit each, 10k a day). The level is the week's views
// across that set; the momentum is the last hour's view growth against
// the mean hourly growth over the samples before it, from vi_samples.
// Growth is only compared between samples of the same video set, so the
// daily change of set cannot read as a spike or a collapse.
//
// The slow path owns it. Without a key the source is unknown.
import { clamp, ratioToBaseline, type SourceComponent } from './score';
import { dailyLedger, pruneSamples, readSamples, writeSample } from './samples';
import { filterRelevantTitles } from './relevance';
import { compareKeeps, jevTitleVerdicts } from './relevance-jev';
import { jevMode } from '../jev';

const API = 'https://www.googleapis.com/youtube/v3';
const CACHE_TTL = 50 * 60 * 1000;
// How long a video set stands before the market searches again. A busy
// market's top videos turn over within a day; a quiet one's barely in
// three; a search that found nothing rarely finds something an hour later
// (it used to retry every hourly run, which alone spent the day's bucket).
const HOUR = 3600 * 1000;
const HOT_TTL = 24 * HOUR;
const BASE_TTL = 48 * HOUR;
const QUIET_TTL = 72 * HOUR;
const EMPTY_TTL = 72 * HOUR;
const HOT_LEVEL = 600;
const HOT_MOMENTUM = 1.5;
const QUIET_LEVEL = 300;
// Share of the set still inside the week below which it is decaying.
const DECAY_SHARE = 0.6;
// A set found a few minutes into one run is otherwise just short of its
// interval at the matching run a day later.
const TTL_SLACK = 15 * 60 * 1000;
// Searches a day for re-discovery; the rest of the 100 stay free for
// markets that have never searched.
const SEARCH_BUDGET = 90;
const SEARCH_CAP = 100;
const LEDGER_TTL = 5 * 60 * 1000;
const WINDOW_DAYS = 7;
// search.list costs the same quota unit at any page size, and videos.list
// reads 50 ids in one call, so the week's top 50 cost what 25 did.
const MAX_VIDEOS = 50;
// Samples kept per market; three days at the hourly cadence.
const SAMPLE_KEEP_MS = 3 * 24 * 3600 * 1000;
const MAX_SAMPLES = 80;
const MIN_PRIOR_DELTAS = 3;
// A gap between samples outside this range is not an hour's growth.
const MIN_GAP_H = 0.5;
const MAX_GAP_H = 3;

const cache = new Map<string, { data: SourceComponent; expiry: number }>();
let ledger: { spent: number; at: number } | null = null;
let searchedThisProcess = 0;

export function youtubeConfigured(): boolean {
  return !!process.env.YOUTUBE_API_KEY;
}

// Week's views over the top videos to level, log scale:
//   1k -> 200, 100k -> 400, 1M -> 500, 10M -> 600, 100M -> 700, 1B -> 800
// Gentler than the other sources' scales because search always finds
// something: a phrase nobody films still returns a page of videos that
// mention it, and a celebrity's week is tens of millions of views.
export function youtubeLevel(views7d: number): number {
  if (views7d <= 0) return 0;
  return clamp(Math.round(100 * Math.log10(views7d) - 100));
}

export interface YoutubeSample {
  sampled_at: string;
  value: number;
  meta: { set?: string | number | boolean | null } | null;
}

// Hourly view growth now against the growth in the hours before, over
// samples of the same video set, newest first. Pure.
export function youtubeMomentum(samples: YoutubeSample[], now = Date.now()): { momentum: number | null; views1h: number | null } {
  if (samples.length < 2) return { momentum: null, views1h: null };
  const deltas: number[] = [];
  for (let i = 0; i + 1 < samples.length; i++) {
    const a = samples[i];
    const b = samples[i + 1];
    if (!a.meta?.set || a.meta.set !== b.meta?.set) continue;
    const hours = (Date.parse(a.sampled_at) - Date.parse(b.sampled_at)) / 3600_000;
    if (hours < MIN_GAP_H || hours > MAX_GAP_H) continue;
    deltas.push(Math.max(0, a.value - b.value) / hours);
  }
  if (deltas.length === 0) return { momentum: null, views1h: null };
  const latestIsCurrent = now - Date.parse(samples[0].sampled_at) < MAX_GAP_H * 3600_000;
  const current = deltas[0];
  const prior = deltas.slice(1);
  const momentum = latestIsCurrent && prior.length >= MIN_PRIOR_DELTAS ? ratioToBaseline(current, prior) : null;
  return { momentum, views1h: Math.round(current) };
}

// How long the stored set stands before the market searches again, from
// the stored reading. Pure.
export function discoveryInterval(stored: SourceComponent | null | undefined): number {
  const ids = typeof stored?.meta?.videos === 'string' && stored.meta.videos ? stored.meta.videos.split(',') : [];
  if (ids.length === 0) return EMPTY_TTL;
  const level = stored?.level ?? 0;
  if (level >= HOT_LEVEL || (stored?.momentum ?? 0) >= HOT_MOMENTUM) return HOT_TTL;
  const inWeek = typeof stored?.meta?.video_count === 'number' ? stored.meta.video_count : ids.length;
  if (inWeek / ids.length < DECAY_SHARE) return HOT_TTL;
  if (level < QUIET_LEVEL) return QUIET_TTL;
  return BASE_TTL;
}

// Whether the market should search this pass. Pure.
export function discoveryDue(stored: SourceComponent | null | undefined, now = Date.now()): boolean {
  const at = typeof stored?.meta?.discovered_at === 'string' ? Date.parse(stored.meta.discovered_at) : NaN;
  if (!Number.isFinite(at)) return true;
  return now - at >= discoveryInterval(stored) - TTL_SLACK;
}

// Searches left today: the budget for re-discovery, the cap for a market
// that has never searched.
async function searchesLeft(neverSearched: boolean): Promise<number> {
  if (!ledger || Date.now() - ledger.at > LEDGER_TTL) {
    ledger = { spent: await dailyLedger('youtube', 'searched'), at: Date.now() };
    searchedThisProcess = 0;
  }
  return (neverSearched ? SEARCH_CAP : SEARCH_BUDGET) - ledger.spent - searchedThisProcess;
}

async function api<T>(path: string, params: Record<string, string>): Promise<{ ok: true; body: T } | { ok: false; status: number }> {
  const search = new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY ?? '' });
  const res = await fetch(`${API}/${path}?${search}`, { headers: { Accept: 'application/json' }, cache: 'no-store' });
  if (!res.ok) {
    console.error(`[youtube] ${path} ${res.status}: ${(await res.text()).slice(0, 160)}`);
    return { ok: false, status: res.status };
  }
  return { ok: true, body: (await res.json()) as T };
}

// The most-viewed videos of the last week for the name and its aliases:
// each quoted so it must appear as a phrase, `|` for OR between them.
// Null when the search failed.
async function discover(term: string, aliases: string[]): Promise<string[] | null> {
  const q = [term, ...aliases.slice(0, 3)]
    .map((s) => s.trim().replace(/"/g, ''))
    .filter(Boolean)
    .map((s) => `"${s}"`)
    .join('|');
  const publishedAfter = new Date(Date.now() - WINDOW_DAYS * 24 * 3600 * 1000).toISOString();
  const res = await api<{ items?: { id?: { videoId?: string } }[] }>('search', {
    part: 'id',
    type: 'video',
    q,
    order: 'viewCount',
    publishedAfter,
    maxResults: String(MAX_VIDEOS),
    safeSearch: 'none',
  });
  if (!res.ok) return null;
  return (res.body.items ?? []).map((i) => i.id?.videoId).filter((id): id is string => !!id);
}

async function viewCounts(ids: string[]): Promise<{ id: string; views: number; publishedAt: string; title: string; channel: string }[] | null> {
  if (ids.length === 0) return [];
  const res = await api<{ items?: { id: string; statistics?: { viewCount?: string }; snippet?: { publishedAt?: string; title?: string; channelTitle?: string } }[] }>('videos', {
    part: 'statistics,snippet',
    id: ids.slice(0, 50).join(','),
  });
  if (!res.ok) return null;
  return (res.body.items ?? []).map((v) => ({
    id: v.id,
    views: Number(v.statistics?.viewCount ?? 0),
    publishedAt: v.snippet?.publishedAt ?? '',
    title: v.snippet?.title ?? '',
    channel: v.snippet?.channelTitle ?? '',
  }));
}

export interface YoutubeRequest {
  term: string;
  aliases?: string[];
  // The market, for the sample series. Without it the reading has a
  // level but never a momentum.
  marketId?: string | null;
  // The stored reading, whose meta carries yesterday's video set.
  stored?: SourceComponent | null;
  // For the title relevance check (lib/vi/relevance.ts).
  entityType?: string | null;
  category?: string | null;
  description?: string | null;
}

export async function fetchYoutubeSignal({ term, aliases = [], marketId, stored, entityType, category, description }: YoutubeRequest): Promise<SourceComponent> {
  const key = `${marketId ?? ''}|${term.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiry) return hit.data;

  const empty: SourceComponent = { source: 'youtube', level: null, momentum: null, fetchedAt: new Date().toISOString() };
  if (!youtubeConfigured() || term.trim().length < 2) return empty;

  try {
    // The stored set until its interval is up; a failed or unaffordable
    // search keeps using it rather than reporting unknown.
    const storedIds = typeof stored?.meta?.videos === 'string' && stored.meta.videos ? stored.meta.videos.split(',') : [];
    const discoveredAt = typeof stored?.meta?.discovered_at === 'string' ? Date.parse(stored.meta.discovered_at) : 0;
    let ids = storedIds;
    let discovered = discoveredAt ? new Date(discoveredAt).toISOString() : null;
    let searched = 0;
    // A new set is checked for relevance; so is a stored set that never
    // was (once, at the market's next hourly read: no search quota).
    let checkTitles = stored?.meta?.title_filter === undefined && ids.length > 0;
    if (discoveryDue(stored)) {
      const neverSearched = !discoveredAt;
      const found = (await searchesLeft(neverSearched)) > 0 ? await discover(term, aliases) : null;
      if (found) {
        ids = found;
        discovered = new Date().toISOString();
        searched = 1;
        searchedThisProcess++;
        checkTitles = true;
      } else if (neverSearched) {
        return empty;
      }
    }

    let videos = await viewCounts(ids);
    if (!videos) return empty;
    let titleFilter: string | null = typeof stored?.meta?.title_filter === 'string' ? stored.meta.title_filter : null;
    let filteredOut: number | null = typeof stored?.meta?.filtered_out === 'number' ? stored.meta.filtered_out : null;
    let jevTitles: Record<string, string | number | null> = {};
    if (checkTitles && videos.length > 0) {
      const subject = { name: term, aliases, entityType, category, description };
      const all = videos;
      const verdict = await filterRelevantTitles(subject, all);
      titleFilter = verdict.status;
      filteredOut = verdict.filteredOut;
      let keep = verdict.status === 'ok' ? verdict.keep : all.map((v) => v.id);
      // Shadow pilot: Jev judges the same titles; both verdicts are kept
      // (component meta, vi_samples yt_title_shadow). JEV_TITLES=on makes
      // Jev's the one that counts.
      const mode = jevMode(process.env.JEV_TITLES);
      if (mode !== 'off') {
        const jv = await jevTitleVerdicts(subject, all);
        if (jv) {
          const cmp = compareKeeps(all.map((v) => v.id), keep, jv.keep);
          jevTitles = { jev_titles: 'ok', jev_keep: jv.keep.length, jev_agree: cmp.agree, jev_disagree: cmp.aOnly.length + cmp.bOnly.length, jev_ms: jv.latency_ms, jev_model: jv.model };
          if (marketId) {
            const title = (id: string) => (all.find((v) => v.id === id)?.title ?? '').slice(0, 80);
            await writeSample(marketId, 'yt_title_shadow', cmp.aOnly.length + cmp.bOnly.length, {
              videos: all.length,
              gemini_status: verdict.status,
              gemini_keep: keep.length,
              jev_keep: jv.keep.length,
              agree: cmp.agree,
              gemini_only: cmp.aOnly.map((id) => `${id}|${jv.probabilities[id]}|${title(id)}`).join(' ;; '),
              jev_only: cmp.bOnly.map((id) => `${id}|${jv.probabilities[id]}|${title(id)}`).join(' ;; '),
              jev_model: jv.model,
              jev_ms: jv.latency_ms,
            });
          }
          if (mode === 'on') {
            keep = jv.keep;
            titleFilter = 'jev';
            filteredOut = all.length - keep.length;
          }
        } else jevTitles = { jev_titles: 'failed' };
      }
      if (verdict.status === 'ok' || mode === 'on') {
        const kept = new Set(keep);
        ids = ids.filter((id) => kept.has(id));
        videos = videos.filter((v) => kept.has(v.id));
        const dropped = all.filter((v) => !kept.has(v.id)).map((v) => v.title);
        if (dropped.length) console.log(`[youtube] title filter "${term}" dropped ${dropped.length}: ${dropped.map((t) => JSON.stringify(t)).join(' | ')}`);
      }
    }
    const cutoff = Date.now() - WINDOW_DAYS * 24 * 3600 * 1000;
    const recent = videos.filter((v) => !v.publishedAt || Date.parse(v.publishedAt) >= cutoff);
    const views7d = recent.reduce((s, v) => s + v.views, 0);
    const top = [...recent].sort((a, b) => b.views - a.views)[0];
    const set = [...ids].sort().join(',').slice(0, 64);

    let momentum: number | null = null;
    let views1h: number | null = null;
    if (marketId) {
      await writeSample(marketId, 'youtube', views7d, searched ? { set, searched } : { set });
      ({ momentum, views1h } = youtubeMomentum(await readSamples(marketId, 'youtube', MAX_SAMPLES)));
      await pruneSamples(marketId, 'youtube', SAMPLE_KEEP_MS);
    }

    const result: SourceComponent = {
      source: 'youtube',
      level: youtubeLevel(views7d),
      momentum,
      fetchedAt: new Date().toISOString(),
      meta: {
        views_7d: views7d,
        views_1h: views1h,
        videos: ids.join(','),
        video_count: recent.length,
        top_video: top?.id ?? null,
        top_views: top?.views ?? null,
        discovered_at: discovered,
        title_filter: titleFilter,
        filtered_out: filteredOut,
        ...jevTitles,
      },
    };
    cache.set(key, { data: result, expiry: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.error(`[youtube] query failed for "${term}":`, err);
    return empty;
  }
}
