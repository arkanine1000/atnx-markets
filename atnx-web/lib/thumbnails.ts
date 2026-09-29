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
//            the article's own lead image is usually the head office. The
//            article must be about a company or product: "Apple" the fruit
//            is not the brand, "Apple Inc." is.
//   person   the Wikipedia article's lead image, which is the portrait, and
//            only when Wikidata says the article is about a human.
//   meme,    the image of the reference page a capture came from (Know
//   trend,   Your Meme, a fandom wiki, Wikipedia), which is the meme itself
//   other    rather than one post about it; then the Know Your Meme entry
//            guessed from the name (its slugs are the title); then the
//            Wikipedia lead image, unless the article is about an ordinary
//            thing that happens to share the name (a given name, a fruit,
//            a planet), or for a meme is not about internet culture at all.
//
// A page counts only when its title is the market's own name: a listing
// or search page hands out the site's logo as its preview, and a Wikipedia
// alias match is too loose ("Verity" the sculpture is not "Verity
// (Minecraft ARG)"). An image that several markets share is a site
// placeholder by definition and is dropped for the screenshot. A market
// nothing knows a picture for keeps its screenshot and is looked at again
// a week later, not every hour.
import { fetchImageFromUrl } from './og';
import { createAdminClient } from './supabase/admin';
import type { Components } from './vi/score';
import {
  fetchArticleFacts,
  fetchArticleSummary,
  fetchWikidataLogo,
  leadSentences,
  fetchWikidataValues,
  fetchWikipediaPageImage,
  resolveArticleTitles,
  titleMatchesTerm,
  WIKIDATA_HUMAN,
  WIKIMEDIA_USER_AGENT,
  type ArticleFacts,
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
// What the first version of this job wrote, before the strategy depended
// on the entity type: the Wikipedia lead image for everything, which gave
// companies their head office. Markets still carrying it are redone on
// sight, no flag needed.
const LEGACY_SOURCE = 'wikipedia';

// Pages whose preview image is the subject itself rather than a post about
// it. A capture submitted from one of these hands us the canonical picture.
const REFERENCE_HOSTS =
  /(^|\.)(knowyourmeme\.com|fandom\.com|wikipedia\.org|wiktionary\.org|urbandictionary\.com|tvtropes\.org)$/i;
const KYM_ENTRY_URL = 'https://knowyourmeme.com/memes/';

// Wikipedia short descriptions, used to tell what an article is about.
// A brand's article describes an organisation or a product.
const BRAND_DESCRIPTION =
  /compan|corporat|brand|business|manufactur|organi[sz]ation|website|platform|service|startup|developer|studio|team|club|league|agency|network|software|product|device|app\b|game|airline|bank|retailer|label|publisher|newspaper|magazine|channel|conglomerate|firm|enterprise|cryptocurrency|blockchain|exchange|chain|franchise|university|party|operator|provider|subsidiary|automaker|carmaker|search engine|social media|streaming|video game|smartphone|model|vehicle|rocket|spacecraft|launch/i;
// An article about an ordinary thing that shares a name with a market.
const ORDINARY_DESCRIPTION =
  /given name|first name|surname|family name|species|genus|plant|fruit|vegetable|animal|bird|fish|insect|mammal|tree|flower|chemical element|planet|dwarf planet|moon of|star in|constellation|deity|god of|goddess|river|lake|island|mountain|town|village|city|municipality|county|province|country|language|letter|numeral|number|year|month|day of|colou?r|mineral|disease|virus|unit of|word|term|concept/i;
// A meme's article is about internet culture, media or a character.
const CULTURE_DESCRIPTION =
  /meme|internet|viral|online|video|slang|catchphrase|phenomen|trend|challenge|prank|hoax|game|song|single|album|character|series|film|show|web|youtube|tiktok|twitter|reddit|streamer|youtuber|creepypasta|alternate reality|subculture|fad|dance|hashtag|campaign|comic|cartoon|animat|mascot|joke|parody|remix|art|image|photograph|template|format|expression|gesture|emoji|movement|controversy|incident|event|scandal|feud|drama|debate|theory|conspiracy|community|fandom/i;

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
  // Looked, nothing found; marked checked (a placeholder it had is gone).
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
  description_source: string | null;
  // The image it has is one other markets have too: a placeholder.
  duplicate: boolean;
};

export interface FoundImage {
  buffer: Buffer;
  contentType: string;
  // Recorded in thumbnail_source: which strategy produced it.
  source: string;
  // The market's own summary from the same place the image came from
  // (supabase/012), so the caption under a logo describes the company,
  // not the screenshot the newest capture was. Recorded in
  // markets.description / description_source.
  description?: string | null;
  descriptionSource?: string | null;
}

// Looks up curated images for at most `limit` highlighted markets that
// have none, carry one from the first version of the job or one that is
// a shared placeholder (or, with redo, any the job chose). One pass is
// bounded so the hourly cron finishes; anything left over is picked up
// next hour.
export async function refreshThumbnails({ limit = 12, redo = false }: RefreshOptions = {}): Promise<ThumbnailRefreshResult> {
  const supabase = createAdminClient();
  const result: ThumbnailRefreshResult = { considered: 0, set: 0, none: 0, failed: 0, log: [] };

  const { data, error } = await supabase
    .from('markets')
    .select(
      'id, entity_name, entity_type, vi_components, current_vi, total_volume_usd, thumbnail_url, thumbnail_source, thumbnail_checked_at, description_source'
    )
    .is('deleted_at', null)
    .order('current_vi', { ascending: false, nullsFirst: false });
  if (error) throw error;

  // Stored images by file name (which carries the content digest), so an
  // image several markets share, or one about to be stored again, is
  // recognised as a placeholder.
  const holders = new Map<string, Set<string>>();
  for (const m of data ?? []) {
    const key = imageKey(m.thumbnail_url);
    if (!key) continue;
    holders.set(key, (holders.get(key) ?? new Set()).add(m.id));
  }
  const markets: Candidate[] = (data ?? []).map((m) => ({
    ...m,
    vi_components: m.vi_components as Components | null,
    sourceUrls: [],
    duplicate: (holders.get(imageKey(m.thumbnail_url) ?? '')?.size ?? 0) > 1,
  }));

  const cutoff = Date.now() - RECHECK_MS;
  const due = markets.filter((m, rank) => {
    const highlighted = rank < HIGHLIGHT_RANK || Number(m.total_volume_usd ?? 0) >= HIGHLIGHT_VOLUME_USD;
    if (!highlighted || m.thumbnail_source === MANUAL_SOURCE) return false;
    if (m.thumbnail_url) return redo || m.duplicate || m.thumbnail_source === LEGACY_SOURCE;
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
      let found = await findImage(market);
      let note = found ? ` (${found.source})` : '';
      if (found) {
        // The same bytes on another market: a site's generic artwork.
        const key = await fileNameFor(found);
        const others = [...(holders.get(key) ?? [])].filter((id) => id !== market.id);
        if (others.length > 0) {
          note = ` (${found.source} is a placeholder, dropped)`;
          found = null;
        } else {
          holders.set(key, (holders.get(key) ?? new Set()).add(market.id));
        }
      }
      const outcome = found ? await storeImage(market, found) : await markChecked(market);
      result[outcome]++;
      result.log.push(`${market.entity_name}: ${outcome}${note}`);
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
      return [brandImage, referencePageImage];
    case 'person':
      return [personImage, referencePageImage];
    default:
      return [referencePageImage, knowYourMemeEntry, subjectLeadImage];
  }
}

// The Wikipedia articles that could be this market's own, best first: the
// title the slow refresh scored against when it is the name itself (it may
// have come from an alias), then every search result that is the name.
async function articlesFor(market: MarketForImage, { corporate = false } = {}): Promise<string[]> {
  const titles: string[] = [];
  const stored = (market.vi_components?.wikipedia?.meta?.title as string | undefined) ?? null;
  if (stored && titleMatchesTerm(market.entity_name, stored, { corporate })) titles.push(stored);
  for (const t of await resolveArticleTitles(market.entity_name, { corporate })) {
    if (!titles.includes(t)) titles.push(t);
  }
  return titles;
}

// Brand: the first candidate article that is about a company or product,
// its logo if Wikidata has one, else its lead image. An article with a
// logo on Wikidata is a brand whatever its description says.
async function brandImage(market: MarketForImage): Promise<FoundImage | null> {
  for (const title of await articlesFor(market, { corporate: true })) {
    const facts = await fetchArticleFacts(title);
    if (!facts || facts.disambiguation) continue;
    const logo = facts.qid ? await fetchWikidataLogo(facts.qid) : null;
    if (logo) return { ...(await download(logo.url)), source: 'wikidata:logo', ...(await articleCaption(facts)) };
    if (!facts.shortDescription || !BRAND_DESCRIPTION.test(facts.shortDescription)) continue;
    const lead = await leadImage(facts);
    if (lead) return lead;
  }
  return null;
}

// Person: the lead image of the first candidate article that Wikidata
// says is about a human. That is the portrait. When the plain name is a
// disambiguation page, several notable people share it and no picture can
// be trusted to be this one's ("John Smith").
async function personImage(market: MarketForImage): Promise<FoundImage | null> {
  for (const title of await articlesFor(market)) {
    const facts = await fetchArticleFacts(title);
    if (!facts) continue;
    if (facts.disambiguation) {
      if (!/\(.*\)\s*$/.test(title)) return null;
      continue;
    }
    if (!facts.qid) continue;
    const kinds = await fetchWikidataValues(facts.qid, 'P31');
    if (!kinds.includes(WIKIDATA_HUMAN)) continue;
    const lead = await leadImage(facts);
    if (lead) return lead;
  }
  return null;
}

// Everything else: the lead image of the first candidate article that is
// not about an ordinary thing sharing the name, and for a meme is about
// internet culture (an article with no description at all is not trusted
// for a meme).
async function subjectLeadImage(market: MarketForImage): Promise<FoundImage | null> {
  for (const title of await articlesFor(market)) {
    const facts = await fetchArticleFacts(title);
    if (!facts || facts.disambiguation) continue;
    const desc = facts.shortDescription;
    if (desc && ORDINARY_DESCRIPTION.test(desc) && !CULTURE_DESCRIPTION.test(desc)) continue;
    if (market.entity_type === 'meme' && !(desc && CULTURE_DESCRIPTION.test(desc))) continue;
    const lead = await leadImage(facts);
    if (lead) return lead;
  }
  return null;
}

async function leadImage(facts: ArticleFacts): Promise<FoundImage | null> {
  const image = await fetchWikipediaPageImage(facts.title);
  if (!image) return null;
  return { ...(await download(image.url)), source: 'wikipedia:lead', ...(await articleCaption(facts)) };
}

// The article's first sentence or two as the market's description. A
// failure here costs the caption, never the image.
async function articleCaption(
  facts: ArticleFacts
): Promise<Pick<FoundImage, 'description' | 'descriptionSource'>> {
  try {
    const summary = await fetchArticleSummary(facts.title);
    const text = summary?.extract ? leadSentences(summary.extract) : null;
    return text ? { description: text, descriptionSource: 'wikipedia' } : {};
  } catch (err) {
    console.warn(`[thumbnails] ${facts.title}: summary failed:`, (err as Error).message);
    return {};
  }
}

// The preview image of the first capture source that is a reference page
// about this market. A capture taken on the site's home, feed or search
// page has a title that is not the market's, and is skipped.
async function referencePageImage(market: MarketForImage): Promise<FoundImage | null> {
  for (const url of market.sourceUrls) {
    let host: string;
    try {
      host = new URL(url).hostname;
    } catch {
      continue;
    }
    if (!REFERENCE_HOSTS.test(host)) continue;
    const found = await pageImage(url, market.entity_name).catch((err: Error) => {
      console.warn(`[thumbnails] ${market.entity_name}: ${url}: ${err.message}`);
      return null;
    });
    if (found) return found;
  }
  return null;
}

// Know Your Meme names its entries by the title, slugified, and redirects
// to the right section (people/, subcultures/) from the bare slug. One
// request either lands on the entry or on a 404.
export async function knowYourMemeEntry(market: MarketForImage): Promise<FoundImage | null> {
  const slug = market.entity_name
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '');
  if (slug.length < 3) return null;
  return pageImage(`${KYM_ENTRY_URL}${slug}`, market.entity_name).catch(() => null);
}

// A page's preview image, accepted only when the page is titled with the
// market's name ("Verity (Minecraft ARG) | Know Your Meme").
export async function pageImage(url: string, name: string): Promise<FoundImage | null> {
  const image = await fetchImageFromUrl(url);
  if (!image.pageTitle || !pageTitleNames(image.pageTitle, name)) return null;
  const host = new URL(url).hostname.replace(/^www\./, '');
  const source = `page:${host}`;
  // The page's own summary (og:description) describes the subject, which
  // for a reference page is the market itself. Wikipedia sets none, so
  // its articles are asked for their intro instead.
  let summary = image.pageContext?.trim();
  if (!summary && /(^|\.)wikipedia\.org$/.test(host)) {
    const title = decodeURIComponent(new URL(url).pathname.replace(/^\/wiki\//, '')).replace(/_/g, ' ');
    summary = (await fetchArticleSummary(title).catch(() => null))?.extract ?? undefined;
  }
  return {
    buffer: Buffer.from(image.imageBase64, 'base64'),
    contentType: image.mediaType,
    source,
    ...(summary && summary.length >= 20 && !isSiteSlogan(summary) ? { description: leadSentences(summary), descriptionSource: source } : {}),
  };
}

// A gallery or category page carries the site's own line as its summary
// ("See more '90s Nostalgia' images on Know Your Meme!"), which says
// nothing about the market. Pure.
export function isSiteSlogan(summary: string): boolean {
  const s = summary.trim();
  return /^(see more|browse|explore|discover|check out|read more)\b/i.test(s) || /\bon know your meme!?$/i.test(s) || /\b(sign up|log in) to\b/i.test(s);
}

// Whether a page title is about the name: the title's first segment
// (before the site's " | Know Your Meme" or " - Wikipedia") is the name,
// or the name appears in it whole.
function pageTitleNames(pageTitle: string, name: string): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[‘’'"“”]/g, '').replace(/[^a-z0-9]+/g, ' ').trim();
  const want = norm(name);
  if (!want) return false;
  const head = norm(pageTitle.split(/\s[|–—-]\s/)[0]);
  return head === want || ` ${norm(pageTitle)} `.includes(` ${want} `);
}

async function storeImage(market: Candidate, found: FoundImage): Promise<'set'> {
  const supabase = createAdminClient();
  const path = `${STORAGE_FOLDER}/${market.id}/${await fileNameFor(found)}`;

  const { error: uploadErr } = await supabase.storage
    .from(STORAGE_BUCKET)
    .upload(path, found.buffer, { contentType: found.contentType, upsert: true, cacheControl: '31536000' });
  if (uploadErr) throw uploadErr;
  const { data: pub } = supabase.storage.from(STORAGE_BUCKET).getPublicUrl(path);

  // Fill the slot, or replace what the job set earlier. An image set by
  // hand since the select is left alone either way.
  let update = supabase
    .from('markets')
    .update({
      thumbnail_url: pub.publicUrl,
      thumbnail_source: found.source,
      thumbnail_checked_at: new Date().toISOString(),
    })
    .eq('id', market.id);
  // The caption travels with the image, except over one written by hand.
  if (found.description && market.description_source !== MANUAL_SOURCE) {
    update = supabase
      .from('markets')
      .update({
        thumbnail_url: pub.publicUrl,
        thumbnail_source: found.source,
        thumbnail_checked_at: new Date().toISOString(),
        description: found.description,
        description_source: found.descriptionSource ?? found.source,
      })
      .eq('id', market.id);
  }
  update = market.thumbnail_url
    ? update.or(`thumbnail_source.is.null,thumbnail_source.neq.${MANUAL_SOURCE}`)
    : update.is('thumbnail_url', null);
  const { error: updateErr } = await update;
  if (updateErr) throw updateErr;

  // The file this replaced is ours and no longer referenced.
  const old = market.thumbnail_url ? storagePath(market.thumbnail_url) : null;
  if (old && old !== path && old.startsWith(`${STORAGE_FOLDER}/${market.id}/`)) {
    await supabase.storage.from(STORAGE_BUCKET).remove([old]);
  }
  return 'set';
}

// Nothing better found. A shared placeholder is cleared so the card goes
// back to the capture; a legacy image that survives the new strategy is
// relabelled as what it is, the Wikipedia lead image, so neither is
// looked at again every hour.
async function markChecked(market: Candidate): Promise<'none'> {
  const patch: { thumbnail_checked_at: string; thumbnail_url?: null; thumbnail_source?: string | null } = {
    thumbnail_checked_at: new Date().toISOString(),
  };
  if (market.thumbnail_url && market.duplicate) {
    patch.thumbnail_url = null;
    patch.thumbnail_source = null;
  } else if (market.thumbnail_url && market.thumbnail_source === LEGACY_SOURCE) {
    patch.thumbnail_source = 'wikipedia:lead';
  }
  const { error } = await createAdminClient().from('markets').update(patch).eq('id', market.id);
  if (error) throw error;
  return 'none';
}

// The stored file name: content digest plus extension, so the same bytes
// always land on the same name and can be recognised across markets.
async function fileNameFor(found: FoundImage): Promise<string> {
  const ext = EXT_BY_TYPE[found.contentType] ?? 'jpg';
  const hash = await crypto.subtle.digest('SHA-1', new Uint8Array(found.buffer));
  const digest = Array.from(new Uint8Array(hash), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${digest.slice(0, 12)}.${ext}`;
}

// The file name at the end of a stored thumbnail URL, or null.
function imageKey(url: string | null): string | null {
  if (!url) return null;
  const name = url.split('?')[0].split('/').pop();
  return name || null;
}

// The object path inside our bucket for a public URL of ours, or null.
function storagePath(url: string): string | null {
  const marker = `/${STORAGE_BUCKET}/`;
  const i = url.indexOf(marker);
  if (i < 0) return null;
  return decodeURIComponent(url.slice(i + marker.length).split('?')[0]);
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
