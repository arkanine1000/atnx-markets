import { toMediaType } from './capture';
import type { VisionMediaType } from './vlm';

// Max bytes we're willing to pull down. The HTML cap is generous because
// Twitter/TikTok ship bloated pages; the image cap matches Claude's 5MB limit.
const MAX_HTML_BYTES = 1_500_000;
const MAX_IMAGE_BYTES = 5_000_000;
const FETCH_TIMEOUT_MS = 8_000;

// A realistic UA — many sites (Twitter/X in particular) serve empty OG to
// unknown bots. We also set Accept-Language so regional sites don't redirect.
const UA =
  'Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0 Mobile Safari/537.36';

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
  accept: string
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
        'user-agent': UA,
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
    .replace(/&nbsp;/g, ' ');
}

function extractTitle(html: string): string | undefined {
  const m = /<title>([^<]*)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).trim() || undefined : undefined;
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
      const m = /\/(?:shorts|embed|v)\/([^/?]+)/.exec(u.pathname);
      if (m) id = m[1];
    }
  }
  if (!id || !/^[A-Za-z0-9_-]{6,}$/.test(id)) return null;
  return `https://i.ytimg.com/vi/${id}/hqdefault.jpg`;
}

function platformFastPath(u: URL): string | null {
  const yt = youtubeThumbnailUrl(u);
  if (yt) return yt;
  return null;
}

export async function fetchImageFromUrl(url: string): Promise<UrlImage> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new OgFetchError('Invalid URL');
  }

  // Platform fast-paths (YouTube thumbnails) avoid the main fetch entirely.
  const fast = platformFastPath(parsed);
  if (fast) {
    console.log('[og] fast-path', { host: parsed.hostname, image: fast });
    const imgRes = await fetchWithLimits(fast, MAX_IMAGE_BYTES, 'image/*');
    if (!imgRes.contentType.startsWith('image/')) {
      throw new OgFetchError(
        `Platform thumbnail returned ${imgRes.contentType || 'unknown type'}`
      );
    }
    return {
      imageBase64: imgRes.buffer.toString('base64'),
      mediaType: toMediaType(imgRes.contentType),
    };
  }

  console.log('[og] fetch', { url });
  const first = await fetchWithLimits(
    url,
    Math.max(MAX_HTML_BYTES, MAX_IMAGE_BYTES),
    'text/html,image/*;q=0.9,*/*;q=0.1'
  );

  if (first.contentType.startsWith('image/')) {
    console.log('[og] direct image', { contentType: first.contentType });
    return {
      imageBase64: first.buffer.toString('base64'),
      mediaType: toMediaType(first.contentType),
    };
  }

  const html = first.buffer.toString('utf8');
  const meta = parseMetaTags(html);
  const imageUrl =
    meta['og:image'] ||
    meta['og:image:secure_url'] ||
    meta['twitter:image'] ||
    meta['twitter:image:src'];
  console.log('[og] html parsed', {
    contentType: first.contentType,
    htmlBytes: first.buffer.byteLength,
    hasOgImage: Boolean(meta['og:image']),
    hasTwitterImage: Boolean(meta['twitter:image'] || meta['twitter:image:src']),
    title: meta['og:title'] || meta['twitter:title'] || extractTitle(html),
  });
  if (!imageUrl) {
    throw new OgFetchError(
      'No og:image or twitter:image on the page (site may block bots)'
    );
  }

  const absoluteImageUrl = new URL(imageUrl, first.finalUrl).toString();
  const imgRes = await fetchWithLimits(absoluteImageUrl, MAX_IMAGE_BYTES, 'image/*');
  if (!imgRes.contentType.startsWith('image/')) {
    throw new OgFetchError(
      `og:image URL returned ${imgRes.contentType || 'unknown type'}`
    );
  }

  const pageTitle = decodeEntities(
    meta['og:title'] || meta['twitter:title'] || extractTitle(html) || ''
  ).trim() || undefined;
  const pageContext = decodeEntities(
    meta['og:description'] || meta['twitter:description'] || ''
  ).trim() || undefined;

  return {
    imageBase64: imgRes.buffer.toString('base64'),
    mediaType: toMediaType(imgRes.contentType),
    pageTitle,
    pageContext,
  };
}
