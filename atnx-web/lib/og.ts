import { toMediaType } from './capture';
import type { VisionMediaType } from './vlm';

// Max bytes we're willing to pull down. The HTML cap is generous because
// Twitter/TikTok ship bloated pages; the image cap matches Claude's 5MB limit.
const MAX_HTML_BYTES = 1_500_000;
const MAX_IMAGE_BYTES = 5_000_000;
const FETCH_TIMEOUT_MS = 8_000;
// Total budget for the page-level attempts (user-agent rotation, oEmbed).
// The final image download has its own timeout on top of this.
const PAGE_BUDGET_MS = 16_000;

// A realistic browser UA. Many sites serve empty OG to unknown bots. We also
// set Accept-Language so regional sites don't redirect.
const BROWSER_UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36';
// Facebook, Instagram and Threads answer their own link crawler with the OG
// tags they hide from a browser (a browser gets a 400 or a login wall).
// Most other sites serve crawlers the same OG they serve browsers, so it is
// the second try everywhere else.
const CRAWLER_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

// Hosts that give a browser UA nothing (login wall or a 400) but answer the
// crawler UA. Tried crawler-first.
const CRAWLER_FIRST_HOSTS = /(^|\.)(facebook\.com|fb\.com|fb\.watch|instagram\.com|threads\.net|threads\.com)$/i;
const TIKTOK_HOSTS = /(^|\.)tiktok\.com$/i;

// Generic platform artwork served in place of a real preview (TikTok's
// logo on its bot page, Facebook/Instagram static assets on their login
// pages). Treated as "no image" so the caller can ask for a screenshot.
const PLACEHOLDER_IMAGE = /\/rsrc\.php\/|tiktok-logo\/|\/static\/images\/tiktok/i;

export interface UrlImage {
  imageBase64: string;
  mediaType: VisionMediaType;
  pageTitle?: string;
  pageContext?: string;
}

// Caller treats this specially: the .reason string is safe to surface to users.
export class OgFetchError extends Error {
  constructor(public reason: string) {
    super(reason);
  }
}

function isSafeUrl(u: URL): boolean {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost') return false;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host.includes(':')) return false;
  return true;
}

async function fetchWithLimits(
  url: string,
  maxBytes: number,
  accept: string,
  userAgent = BROWSER_UA
): Promise<{ buffer: Buffer; contentType: string; finalUrl: string }> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OgFetchError('Invalid URL');
  }
  if (!isSafeUrl(parsed)) {
    throw new OgFetchError('URL not allowed (private or non-http)');
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(parsed.toString(), {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': userAgent,
        accept,
        'accept-language': 'en-US,en;q=0.9',
      },
    });
    if (!res.ok) {
      throw new OgFetchError(`Upstream returned ${res.status}`);
    }
    if (!res.body) {
      throw new OgFetchError('Empty response body');
    }
    try {
      const finalParsed = new URL(res.url);
      if (!isSafeUrl(finalParsed)) {
        throw new OgFetchError('Redirected to disallowed URL');
      }
    } catch (e) {
      if (e instanceof OgFetchError) throw e;
      throw new OgFetchError('Invalid redirect target');
    }

    const contentType = res.headers.get('content-type')?.split(';')[0].trim() ?? '';
    const reader = res.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) {
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel();
          throw new OgFetchError(`Response exceeded ${maxBytes} bytes`);
        }
        chunks.push(value);
      }
    }
    return { buffer: Buffer.concat(chunks), contentType, finalUrl: res.url };
  } catch (e) {
    if (e instanceof OgFetchError) throw e;
    if ((e as Error).name === 'AbortError') {
      throw new OgFetchError('Fetch timed out');
    }
    throw new OgFetchError(`Fetch failed: ${(e as Error).message}`);
  } finally {
    clearTimeout(timer);
  }
}

function parseMetaTags(html: string): Record<string, string> {
  const out: Record<string, string> = {};
  const metaRe = /<meta\s+([^>]+?)\/?>/gi;
  for (const m of html.matchAll(metaRe)) {
    const attrs = m[1];
    const key =
      /(?:property|name)\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] ??
      /(?:property|name)\s*=\s*([^\s>]+)/i.exec(attrs)?.[1];
    const content =
      /content\s*=\s*["']([^"']*)["']/i.exec(attrs)?.[1] ??
      /content\s*=\s*([^\s>]+)/i.exec(attrs)?.[1];
    if (key && content && !(key in out)) out[key.toLowerCase()] = content;
  }
  return out;
}

function decodeEntities(s: string): string {
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&#x27;/g, "'")
    .replace(/&#x2F;/gi, '/')
    .replace(/&nbsp;/g, ' ');
}

function extractTitle(html: string): string | undefined {
  const m = /<title[^>]*>([^<]*)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).trim() || undefined : undefined;
}

function clean(s: string | undefined): string | undefined {
  return s ? decodeEntities(s).trim() || undefined : undefined;
}

// Platform-specific thumbnail shortcuts. These dodge the HTML-scraping path
// for sites that either block server UAs (X, IG) or gate content behind JS.
function youtubeThumbnailUrl(u: URL): string | null {
  const host = u.hostname.toLowerCase().replace(/^www\./, '');
  let id: string | null = null;
  if (host === 'youtu.be') {
    id = u.pathname.split('/').filter(Boolean)[0] ?? null;
  } else if (host === 'youtube.com' || host.endsWith('.youtube.com')) {
    id = u.searchParams.get('v');
    if (!id) {
      const m = /\/(?:shorts|embed|v|live)\/([^/?]+)/.exec(u.pathname);
      if (m) id = m[1];
    }
  }
  if (!id || !/^[A-Za-z0-9_-]{6,}$/.test(id)) return null;
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

async function downloadImage(
  imageUrl: string,
  what: string
): Promise<{ imageBase64: string; mediaType: VisionMediaType }> {
  const imgRes = await fetchWithLimits(imageUrl, MAX_IMAGE_BYTES, 'image/*');
  if (!imgRes.contentType.startsWith('image/')) {
    throw new OgFetchError(`${what} returned ${imgRes.contentType || 'unknown type'}`);
  }
  return {
    imageBase64: imgRes.buffer.toString('base64'),
    mediaType: toMediaType(imgRes.contentType),
  };
}

// --- TikTok -----------------------------------------------------------
//
// TikTok's HTML is a JavaScript shell (or a captcha page) for anyone it does
// not recognise as a browser, so the meta tags are usually absent. Two
// better sources: the public oEmbed endpoint, and the page's hydration JSON
// which carries the video cover and caption when the page does render.

interface TikTokOembed {
  thumbnail_url?: string;
  title?: string;
  author_name?: string;
}

async function tiktokOembed(url: string): Promise<UrlImage | null> {
  const endpoint = `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`;
  let body: TikTokOembed;
  try {
    const res = await fetchWithLimits(endpoint, 200_000, 'application/json');
    body = JSON.parse(res.buffer.toString('utf8')) as TikTokOembed;
  } catch (err) {
    console.log('[og] tiktok oembed failed', (err as Error).message);
    return null;
  }
  if (!body.thumbnail_url) return null;
  const image = await downloadImage(body.thumbnail_url, 'TikTok thumbnail');
  const title = clean(body.title);
  return {
    ...image,
    pageTitle: title,
    pageContext: [body.author_name ? `TikTok by ${body.author_name}` : null, title]
      .filter(Boolean)
      .join(': ') || undefined,
  };
}

// Depth-first search for the first object that satisfies `pred`.
function deepFind(
  node: unknown,
  pred: (o: Record<string, unknown>) => boolean,
  depth = 0
): Record<string, unknown> | null {
  if (depth > 12 || node === null || typeof node !== 'object') return null;
  if (!Array.isArray(node)) {
    const obj = node as Record<string, unknown>;
    if (pred(obj)) return obj;
    for (const v of Object.values(obj)) {
      const hit = deepFind(v, pred, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const v of node) {
    const hit = deepFind(v, pred, depth + 1);
    if (hit) return hit;
  }
  return null;
}

function tiktokHydration(html: string): { cover?: string; desc?: string; author?: string } | null {
  const m =
    /<script[^>]+id="__UNIVERSAL_DATA_FOR_REHYDRATION__"[^>]*>([\s\S]*?)<\/script>/i.exec(html) ??
    /<script[^>]+id="SIGI_STATE"[^>]*>([\s\S]*?)<\/script>/i.exec(html);
  if (!m) return null;
  let data: unknown;
  try {
    data = JSON.parse(m[1]);
  } catch {
    return null;
  }
  const item = deepFind(data, (o) => {
    const video = o.video as Record<string, unknown> | undefined;
    return typeof o.desc === 'string' && !!video && typeof video.cover === 'string';
  });
  if (!item) return null;
  const video = item.video as Record<string, unknown>;
  const author = item.author as Record<string, unknown> | undefined;
  return {
    cover: (video.originCover as string | undefined) || (video.cover as string),
    desc: item.desc as string,
    author: typeof author?.nickname === 'string' ? author.nickname : undefined,
  };
}

// --- Generic page scrape ----------------------------------------------

interface ParsedPage {
  imageUrl?: string;
  title?: string;
  description?: string;
  loginWall: boolean;
}

function parsePage(html: string, finalUrl: string): ParsedPage {
  const meta = parseMetaTags(html);
  const raw =
    meta['og:image'] ||
    meta['og:image:secure_url'] ||
    meta['og:image:url'] ||
    meta['twitter:image'] ||
    meta['twitter:image:src'];
  // OG URLs are HTML-escaped (`&amp;` between query params). Passing them
  // through undecoded breaks signed CDN URLs, which then answer 403.
  let imageUrl: string | undefined;
  if (raw) {
    try {
      const abs = new URL(decodeEntities(raw), finalUrl).toString();
      imageUrl = PLACEHOLDER_IMAGE.test(abs) ? undefined : abs;
    } catch {
      imageUrl = undefined;
    }
  }
  let loginWall = false;
  try {
    const path = new URL(finalUrl).pathname;
    loginWall = /\/(accounts\/)?login\/?$/i.test(path) || /^\/login\b/i.test(path);
  } catch {
    // keep false
  }
  return {
    imageUrl,
    title: clean(meta['og:title'] || meta['twitter:title'] || extractTitle(html)),
    description: clean(meta['og:description'] || meta['twitter:description']),
    loginWall,
  };
}

function hostLabel(u: URL): string {
  return u.hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
}

export async function fetchImageFromUrl(url: string): Promise<UrlImage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OgFetchError('Invalid URL');
  }
  if (!isSafeUrl(parsed)) {
    throw new OgFetchError('URL not allowed (private or non-http)');
  }

  // Platform fast-paths (YouTube thumbnails) avoid the main fetch entirely.
  const yt = youtubeThumbnailUrl(parsed);
  if (yt) {
    console.log('[og] fast-path', { host: parsed.hostname, image: yt });
    return downloadImage(yt, 'Platform thumbnail');
  }

  const deadline = Date.now() + PAGE_BUDGET_MS;
  const host = hostLabel(parsed);
  const isTikTok = TIKTOK_HOSTS.test(parsed.hostname);

  if (isTikTok) {
    const viaOembed = await tiktokOembed(url);
    if (viaOembed) {
      console.log('[og] tiktok oembed', { url });
      return viaOembed;
    }
  }

  const agents = CRAWLER_FIRST_HOSTS.test(parsed.hostname)
    ? [CRAWLER_UA, BROWSER_UA]
    : [BROWSER_UA, CRAWLER_UA];
  let lastReason = '';

  for (const ua of agents) {
    if (Date.now() > deadline) break;
    const agent = ua === CRAWLER_UA ? 'crawler' : 'browser';
    let first: Awaited<ReturnType<typeof fetchWithLimits>>;
    try {
      first = await fetchWithLimits(
        url,
        Math.max(MAX_HTML_BYTES, MAX_IMAGE_BYTES),
        'text/html,image/*;q=0.9,*/*;q=0.1',
        ua
      );
    } catch (err) {
      lastReason = err instanceof OgFetchError ? err.reason : (err as Error).message;
      console.log('[og] page fetch failed', { url, agent, reason: lastReason });
      continue;
    }

    if (first.contentType.startsWith('image/')) {
      console.log('[og] direct image', { contentType: first.contentType });
      return {
        imageBase64: first.buffer.toString('base64'),
        mediaType: toMediaType(first.contentType),
      };
    }

    const html = first.buffer.toString('utf8');

    if (isTikTok) {
      const hydrated = tiktokHydration(html);
      if (hydrated?.cover) {
        try {
          const image = await downloadImage(hydrated.cover, 'TikTok cover');
          console.log('[og] tiktok hydration', { url, agent });
          const desc = clean(hydrated.desc);
          return {
            ...image,
            pageTitle: desc,
            pageContext: [hydrated.author ? `TikTok by ${hydrated.author}` : null, desc]
              .filter(Boolean)
              .join(': ') || undefined,
          };
        } catch (err) {
          lastReason = err instanceof OgFetchError ? err.reason : (err as Error).message;
        }
      }
      // A redirect from a short link lands on the canonical /video/ URL,
      // which oEmbed accepts even when it refused the short form.
      if (first.finalUrl !== url && /\/(video|photo)\/\d+/.test(first.finalUrl)) {
        const viaOembed = await tiktokOembed(first.finalUrl.split('?')[0]);
        if (viaOembed) return viaOembed;
      }
    }

    const page = parsePage(html, first.finalUrl);
    console.log('[og] html parsed', {
      url,
      agent,
      contentType: first.contentType,
      htmlBytes: first.buffer.byteLength,
      finalUrl: first.finalUrl,
      hasImage: Boolean(page.imageUrl),
      loginWall: page.loginWall,
      title: page.title,
    });

    if (page.loginWall) {
      lastReason = `${host} only shows this to signed-in users`;
      continue;
    }
    if (!page.imageUrl) {
      lastReason = `${host} did not give a preview image`;
      continue;
    }

    try {
      const image = await downloadImage(page.imageUrl, 'og:image URL');
      return { ...image, pageTitle: page.title, pageContext: page.description };
    } catch (err) {
      lastReason = err instanceof OgFetchError ? err.reason : (err as Error).message;
      console.log('[og] image download failed', { url, agent, reason: lastReason });
    }
  }

  throw new OgFetchError(lastReason || `${host} did not give a preview image`);
}
