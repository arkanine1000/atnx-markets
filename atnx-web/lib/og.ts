import { toMediaType } from './capture';
import type { VisionMediaType } from './claude-vision';

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

// Only allow plain http(s) URLs where the hostname is a real domain — not
// an IP literal and not localhost. That blocks the common SSRF targets
// (169.254.169.254 cloud metadata, 127.0.0.1 services, etc.) without needing
// full DNS resolution. Serverless outbound networks typically block private
// ranges at the infra layer anyway, so this is defense-in-depth.
function isSafeUrl(u: URL): boolean {
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (host === 'localhost') return false;
  // IPv4 literal
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  // IPv6 literal (always wrapped in [])
  if (host.includes(':')) return false;
  return true;
}

async function fetchWithLimits(
  url: string,
  maxBytes: number,
  accept: string
): Promise<{ buffer: Buffer; contentType: string; finalUrl: string } | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (!isSafeUrl(parsed)) return null;

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
    if (!res.ok || !res.body) return null;
    // Re-validate the post-redirect URL against SSRF rules.
    try {
      const finalParsed = new URL(res.url);
      if (!isSafeUrl(finalParsed)) return null;
    } catch {
      return null;
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
          return null;
        }
        chunks.push(value);
      }
    }
    return { buffer: Buffer.concat(chunks), contentType, finalUrl: res.url };
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// Parse <meta> tags into a property→content map. We accept both `property=`
// (OGP) and `name=` (Twitter Cards, generic). Handles single/double quotes
// and either attribute order.
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

// Fetch an OG image (or direct image URL) for a shared link and shape it into
// the form processCapture wants. Returns null if no usable image was found —
// caller decides how to surface that to the user.
export async function fetchImageFromUrl(url: string): Promise<UrlImage | null> {
  // First hop: could be HTML or an image depending on what the user shared.
  const first = await fetchWithLimits(
    url,
    // Generous cap because the first hop might be either an image or HTML.
    Math.max(MAX_HTML_BYTES, MAX_IMAGE_BYTES),
    'text/html,image/*;q=0.9,*/*;q=0.1'
  );
  if (!first) return null;

  // Direct image link (imgur, raw CDN, etc).
  if (first.contentType.startsWith('image/')) {
    return {
      imageBase64: first.buffer.toString('base64'),
      mediaType: toMediaType(first.contentType),
    };
  }

  // Treat anything non-image as HTML and scrape.
  const html = first.buffer.toString('utf8');
  const meta = parseMetaTags(html);
  const imageUrl =
    meta['og:image'] ||
    meta['og:image:secure_url'] ||
    meta['twitter:image'] ||
    meta['twitter:image:src'];
  if (!imageUrl) return null;

  const absoluteImageUrl = new URL(imageUrl, first.finalUrl).toString();
  const imgRes = await fetchWithLimits(
    absoluteImageUrl,
    MAX_IMAGE_BYTES,
    'image/*'
  );
  if (!imgRes) return null;
  if (!imgRes.contentType.startsWith('image/')) return null;

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
