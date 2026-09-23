// Curated market images, filled in after the fact.
//
// A market's card shows whatever its newest capture was: a phone screenshot
// of a tweet, a cropped news page. That is the honest default (pump.fun
// shows what the creator uploaded), but the markets people see first
// deserve a cleaner picture (Polymarket curates every one). This is the
// hybrid: for the highlighted markets, the top of the board by VI or any
// with real trade volume, the hourly slow refresh looks up the entity's
// Wikipedia lead image, copies it into our storage, and writes the URL to
// markets.thumbnail_url. Cards and the hero prefer it when set. Nothing on
// the submit path waits for this.
//
// Wikipedia because the VI pipeline already resolves each market to an
// article (the strict name match in vi/wikipedia.ts) and stores the title
// in vi_components, so most lookups cost one pageimages call and one
// download, and the images come licensed for reuse or as the entity's own
// logo. A market Wikipedia has no picture for keeps its screenshot and is
// looked at again a week later, not every hour.
import { createAdminClient } from './supabase/admin';
import type { Components } from './vi/score';
import { fetchWikipediaPageImage, resolveArticleTitle, WIKIMEDIA_USER_AGENT } from './vi/wikipedia';

// A market is highlighted when it is in the top HIGHLIGHT_RANK live markets
// by VI (the first screens of the board) or has traded at least
// HIGHLIGHT_VOLUME_USD of simulated USDC.
export const HIGHLIGHT_RANK = 24;
export const HIGHLIGHT_VOLUME_USD = 1_000;

// Markets with no image found are retried after this long.
const RECHECK_MS = 7 * 24 * 60 * 60 * 1000;
// Wikimedia asks for gentle, serial traffic from one client.
const GAP_MS = 500;
const MAX_IMAGE_BYTES = 8_000_000;
const FETCH_TIMEOUT_MS = 15_000;

const STORAGE_BUCKET = 'captures';
const STORAGE_FOLDER = 'markets';

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface ThumbnailRefreshResult {
  // Highlighted markets without an image that were due a look.
  considered: number;
  // Got a curated image this run.
  set: number;
  // Looked, nothing on Wikipedia; marked checked.
  none: number;
  // A lookup or upload threw; left for the next run.
  failed: number;
  // Names for the log, in the order they were handled.
  log: string[];
}

type Candidate = {
  id: string;
  entity_name: string;
  aliases: string[] | null;
  vi_components: Components | null;
  current_vi: number | null;
  total_volume_usd: number | null;
  thumbnail_url: string | null;
  thumbnail_checked_at: string | null;
};

// Looks up curated images for at most `limit` highlighted markets that
// have none. One pass is bounded so the hourly cron finishes; anything
// left over is picked up next hour.
export async function refreshThumbnails(limit = 12): Promise<ThumbnailRefreshResult> {
  const supabase = createAdminClient();
  const result: ThumbnailRefreshResult = { considered: 0, set: 0, none: 0, failed: 0, log: [] };

  const { data, error } = await supabase
    .from('markets')
    .select('id, entity_name, aliases, vi_components, current_vi, total_volume_usd, thumbnail_url, thumbnail_checked_at')
    .is('deleted_at', null)
    .order('current_vi', { ascending: false, nullsFirst: false });
  if (error) throw error;
  const markets = (data ?? []) as Candidate[];

  const cutoff = Date.now() - RECHECK_MS;
  const due = markets.filter((m, rank) => {
    const highlighted = rank < HIGHLIGHT_RANK || Number(m.total_volume_usd ?? 0) >= HIGHLIGHT_VOLUME_USD;
    if (!highlighted || m.thumbnail_url) return false;
    const checked = m.thumbnail_checked_at ? new Date(m.thumbnail_checked_at).getTime() : 0;
    return checked < cutoff;
  });
  result.considered = due.length;

  for (const market of due.slice(0, limit)) {
    try {
      const outcome = await curateMarket(market);
      result[outcome]++;
      result.log.push(`${market.entity_name}: ${outcome}`);
    } catch (err) {
      result.failed++;
      result.log.push(`${market.entity_name}: failed`);
      console.error(`[thumbnails] ${market.entity_name} failed:`, err);
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  return result;
}

// One market: find its article, take the lead image, store it. Returns
// what happened so the caller can count it.
async function curateMarket(market: Candidate): Promise<'set' | 'none'> {
  const supabase = createAdminClient();
  const now = new Date().toISOString();

  // The slow refresh already resolved the article, with the strict name
  // match; only fall back to a fresh search when it has not run yet.
  let title = (market.vi_components?.wikipedia?.meta?.title as string | undefined) ?? null;
  if (!title) title = await resolveArticleTitle(market.entity_name);
  for (const alias of market.aliases ?? []) {
    if (title || alias.trim().length < 2) break;
    title = await resolveArticleTitle(alias);
  }

  const image = title ? await fetchWikipediaPageImage(title) : null;
  if (!image) {
    const { error } = await supabase
      .from('markets')
      .update({ thumbnail_checked_at: now })
      .eq('id', market.id);
    if (error) throw error;
    return 'none';
  }

  const { buffer, contentType } = await download(image.url);
  const ext = EXT_BY_TYPE[contentType] ?? 'jpg';
  const digest = await sha1Hex(buffer);
  const path = `${STORAGE_FOLDER}/${market.id}/${digest.slice(0, 12)}.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, buffer, { contentType, upsert: true, cacheControl: '31536000' });
  if (uploadErr) throw uploadErr;
  const { data: pub } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);

  // Only fill an empty slot: an image set by hand since the select wins.
  const { error: updateErr } = await supabase
    .from('markets')
    .update({ thumbnail_url: pub.publicUrl, thumbnail_source: 'wikipedia', thumbnail_checked_at: now })
    .eq('id', market.id)
    .is('thumbnail_url', null);
  if (updateErr) throw updateErr;
  return 'set';
}

async function download(url: string): Promise<{ buffer: Buffer; contentType: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      headers: { 'User-Agent': WIKIMEDIA_USER_AGENT, Accept: 'image/*' },
    });
    if (!res.ok) throw new Error(`image ${res.status}`);
    const contentType = res.headers.get('content-type')?.split(';')[0].trim() ?? '';
    if (!contentType.startsWith('image/')) throw new Error(`not an image: ${contentType || 'unknown'}`);
    const declared = Number(res.headers.get('content-length') ?? 0);
    if (declared > MAX_IMAGE_BYTES) throw new Error(`image too large: ${declared} bytes`);
    const buffer = Buffer.from(await res.arrayBuffer());
    if (buffer.byteLength > MAX_IMAGE_BYTES) throw new Error(`image too large: ${buffer.byteLength} bytes`);
    return { buffer, contentType };
  } finally {
    clearTimeout(timer);
  }
}

async function sha1Hex(buffer: Buffer): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-1', new Uint8Array(buffer));
  return Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
}
