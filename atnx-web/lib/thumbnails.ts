// Curated market images, filled in after the fact.
//
// A market's card shows whatever its newest capture was: a phone screenshot
// of a tweet, a cropped news page. That is the honest default (pump.fun
// shows what the creator uploaded), but the markets people see first
// deserve a cleaner picture (Polymarket curates every one). This is the
// hybrid: for the highlighted markets, the top of the board by VI or any
// with real trade volume, the hourly slow refresh finds a canonical image,
// copies it into our storage, and writes markets.thumbnail_url. Cards and
// the hero prefer it when set. Nothing on the submit path waits for this.
//
// Where the image comes from depends on what the market is:
//
//   brand    the logo, from Wikidata (P154) through the Wikipedia article;
//            the article's own lead image is usually the head office.
//   person   the Wikipedia article's lead image, which is the portrait.
//   meme,    the image of the reference page a capture came from (Know
//   trend,   Your Meme, a fandom wiki, Wikipedia), which is the meme itself
//   other    rather than one post about it; then the article's lead image.
//
// The Wikipedia article counts only when its title is the market's own
// name: an alias is too loose for a picture ("Verity" the sculpture is not
// "Verity (Minecraft ARG)"). A market nothing knows a picture for keeps its
// screenshot and is looked at again a week later, not every hour.
import { fetchImageFromUrl } from './og';
import { createAdminClient } from './supabase/admin';
import type { Components } from './vi/score';
import {
  fetchWikidataLogo,
  fetchWikipediaPageImage,
  resolveArticleTitle,
  titleMatchesTerm,
  WIKIMEDIA_USER_AGENT,
} from './vi/wikipedia';

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

// A thumbnail_source set by a person; the job never touches these.
export const MANUAL_SOURCE = 'manual';

// Pages whose preview image is the subject itself rather than a post about
// it. A capture submitted from one of these hands us the canonical picture.
const REFERENCE_HOSTS =
  /(^|\.)(knowyourmeme\.com|fandom\.com|wikipedia\.org|wiktionary\.org|urbandictionary\.com|tvtropes\.org)$/i;

const EXT_BY_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
};

export interface ThumbnailRefreshResult {
  // Highlighted markets that were due a look.
  considered: number;
  // Got a curated image this run.
  set: number;
  // Looked, nothing found; marked checked.
  none: number;
  // A lookup or upload threw; left for the next run.
  failed: number;
  // Names and outcomes for the log, in the order they were handled.
  log: string[];
}

export interface RefreshOptions {
  // Markets handled in one pass.
  limit?: number;
  // Also revisit markets whose image the job set earlier (never a manual
  // one), so a better strategy replaces what an older pass chose. The old
  // image stays until the new one is stored.
  redo?: boolean;
}

export type MarketForImage = {
  id: string;
  entity_name: string;
  entity_type: string | null;
  vi_components: Components | null;
  // Source pages of the market's captures, newest first.
  sourceUrls: string[];
};

type Candidate = MarketForImage & {
  current_vi: number | null;
  total_volume_usd: number | null;
  thumbnail_url: string | null;
  thumbnail_source: string | null;
  thumbnail_checked_at: string | null;
};

export interface FoundImage {
  buffer: Buffer;
  contentType: string;
  // Recorded in thumbnail_source: which strategy produced it.
  source: string;
}

// Looks up curated images for at most `limit` highlighted markets that
// have none (or, with redo, whose image the job chose earlier). One pass is
// bounded so the hourly cron finishes; anything left over is picked up
// next hour.
export async function refreshThumbnails({ limit = 12, redo = false }: RefreshOptions = {}): Promise<ThumbnailRefreshResult> {
  const supabase = createAdminClient();
  const result: ThumbnailRefreshResult = { considered: 0, set: 0, none: 0, failed: 0, log: [] };

  const { data, error } = await supabase
    .from('markets')
    .select(
      'id, entity_name, entity_type, vi_components, current_vi, total_volume_usd, thumbnail_url, thumbnail_source, thumbnail_checked_at'
    )
    .is('deleted_at', null)
    .order('current_vi', { ascending: false, nullsFirst: false });
  if (error) throw error;
  const markets = (data ?? []).map((m) => ({ ...m, sourceUrls: [] as string[] })) as Candidate[];

  const cutoff = Date.now() - RECHECK_MS;
  const due = markets.filter((m, rank) => {
    const highlighted = rank < HIGHLIGHT_RANK || Number(m.total_volume_usd ?? 0) >= HIGHLIGHT_VOLUME_USD;
    if (!highlighted || m.thumbnail_source === MANUAL_SOURCE) return false;
    if (m.thumbnail_url) return redo;
    const checked = m.thumbnail_checked_at ? new Date(m.thumbnail_checked_at).getTime() : 0;
    return checked < cutoff;
  });
  result.considered = due.length;
  const batch = due.slice(0, limit);
  if (batch.length === 0) return result;

  // Where each market's captures came from, newest first.
  const { data: captures, error: capErr } = await supabase
    .from('captures')
    .select('market_id, source_url')
    .in('market_id', batch.map((m) => m.id))
    .is('deleted_at', null)
    .not('source_url', 'is', null)
    .order('created_at', { ascending: false });
  if (capErr) throw capErr;
  const byMarket = new Map<string, string[]>();
  for (const c of captures ?? []) {
    if (!c.market_id || !c.source_url) continue;
    const list = byMarket.get(c.market_id) ?? [];
    list.push(c.source_url);
    byMarket.set(c.market_id, list);
  }

  for (const market of batch) {
    market.sourceUrls = byMarket.get(market.id) ?? [];
    try {
      const found = await findImage(market);
      const outcome = found ? await storeImage(market, found, redo) : await markChecked(market);
      result[outcome]++;
      result.log.push(`${market.entity_name}: ${outcome}${found ? ` (${found.source})` : ''}`);
    } catch (err) {
      result.failed++;
      result.log.push(`${market.entity_name}: failed`);
      console.error(`[thumbnails] ${market.entity_name} failed:`, err);
    }
    await new Promise((r) => setTimeout(r, GAP_MS));
  }
  return result;
}

// The strategies for a market, in the order to try them. Exported so the
// probe script can show what a market would get without writing anything.
export async function findImage(market: MarketForImage): Promise<FoundImage | null> {
  const strategies = strategiesFor(market.entity_type);
  for (const strategy of strategies) {
    try {
      const found = await strategy(market);
      if (found) return found;
    } catch (err) {
      console.warn(`[thumbnails] ${market.entity_name}: ${strategy.name} failed:`, (err as Error).message);
    }
  }
  return null;
}

type Strategy = (market: MarketForImage) => Promise<FoundImage | null>;

function strategiesFor(entityType: string | null): Strategy[] {
  switch (entityType) {
    case 'brand':
      return [wikidataLogo, wikipediaLeadImage, referencePageImage];
    case 'person':
      return [wikipediaLeadImage, referencePageImage];
    default:
      return [referencePageImage, wikipediaLeadImage];
  }
}

// The Wikipedia article that is this market's own name, or null. The slow
// refresh stores the title it scored against, but that may have come from
// an alias; only a title that is the name itself is used for a picture.
async function articleFor(market: MarketForImage): Promise<string | null> {
  const stored = (market.vi_components?.wikipedia?.meta?.title as string | undefined) ?? null;
  if (stored && titleMatchesTerm(market.entity_name, stored)) return stored;
  return resolveArticleTitle(market.entity_name);
}

async function wikidataLogo(market: MarketForImage): Promise<FoundImage | null> {
  const title = await articleFor(market);
  if (!title) return null;
  const logo = await fetchWikidataLogo(title);
  if (!logo) return null;
  return { ...(await download(logo.url)), source: 'wikidata:logo' };
}

async function wikipediaLeadImage(market: MarketForImage): Promise<FoundImage | null> {
  const title = await articleFor(market);
  if (!title) return null;
  const image = await fetchWikipediaPageImage(title);
  if (!image) return null;
  return { ...(await download(image.url)), source: 'wikipedia:lead' };
}

// The preview image of the first capture source that is a reference page.
async function referencePageImage(market: MarketForImage): Promise<FoundImage | null> {
  for (const url of market.sourceUrls) {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (!REFERENCE_HOSTS.test(host)) continue;
    const image = await fetchImageFromUrl(url);
    return {
      buffer: Buffer.from(image.imageBase64, 'base64'),
      contentType: image.mediaType,
      source: `page:${host.replace(/^www\./, '')}`,
    };
  }
  return null;
}

async function storeImage(market: Candidate, found: FoundImage, redo: boolean): Promise<'set'> {
  const supabase = createAdminClient();
  const ext = EXT_BY_TYPE[found.contentType] ?? 'jpg';
  const digest = await sha1Hex(found.buffer);
  const path = `${STORAGE_FOLDER}/${market.id}/${digest.slice(0, 12)}.${ext}`;

  const { error: uploadErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, found.buffer, { contentType: found.contentType, upsert: true, cacheControl: '31536000' });
  if (uploadErr) throw uploadErr;
  const { data: pub } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);

  // Fill the slot, or on a redo replace what the job set earlier. An image
  // set by hand since the select is left alone either way.
  let update = supabase
    .from('markets')
    .update({
      thumbnail_url: pub.publicUrl,
      thumbnail_source: found.source,
      thumbnail_checked_at: new Date().toISOString(),
    })
    .eq('id', market.id);
  update = redo
    ? update.or(`thumbnail_source.is.null,thumbnail_source.neq.${MANUAL_SOURCE}`)
    : update.is('thumbnail_url', null);
  const { error: updateErr } = await update;
  if (updateErr) throw updateErr;
  return 'set';
}

async function markChecked(market: Candidate): Promise<'none'> {
  const { error } = await createAdminClient()
    .from('markets')
    .update({ thumbnail_checked_at: new Date().toISOString() })
    .eq('id', market.id);
  if (error) throw error;
  return 'none';
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
