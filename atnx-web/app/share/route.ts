import { after, NextResponse } from 'next/server';
import {
  contentHash,
  findByHash,
  findEarlierRejection,
  processCapture,
  SubmissionRejectedError,
  toMediaType,
  type ProcessCaptureResult,
} from '@/lib/capture';
import { fetchImageFromUrl, OgFetchError } from '@/lib/og';
import { createClient } from '@/lib/supabase/server';

// Android share target. The manifest registers /share with method=POST and
// enctype=multipart/form-data; picking ATNX from the share sheet POSTs
// {title, text, url, image} here. We run the same pipeline as /api/captures
// and redirect to the new market so the PWA feels native on Android.
//
// What arrives depends on the app that shared:
//   1. Image share (screenshot from the gallery): `image` file present.
//   2. Link share (YouTube, TikTok, Instagram, Facebook, X, ...): the URL,
//      usually inside `text` rather than `url`, sometimes with a caption.
//   3. Text share (a caption, a headline, a name): no URL at all.
//
// An image is captured directly. A link is captured from its preview image
// when the site gives one, else from the caption when there is one, and
// otherwise the user lands on the Create form with the link filled in so a
// screenshot finishes the job. Facebook, Instagram and TikTok all block
// server-side previews most of the time, so that last path is the common
// one for them; it must not dead-end on an error banner.

// Bounds the model call plus the after() work (VI scoring, and the retry
// for a low-confidence create).
export const maxDuration = 60;

const URL_RE = /https?:\/\/[^\s<>"']+/gi;

// First URL in a blob of share text, without the punctuation apps glue on
// ("...link. Check it out!" or a closing bracket).
function firstUrl(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const m = new RegExp(URL_RE.source, 'i').exec(text);
  if (!m) return undefined;
  const url = m[0].replace(/[.,;:!?)\]}'"]+$/, '');
  try {
    new URL(url);
    return url;
  } catch {
    return undefined;
  }
}

// The share text with URLs removed: the caption, if the app sent one.
function captionOf(...parts: Array<string | null | undefined>): string {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of parts) {
    const s = (p ?? '').replace(URL_RE, ' ').replace(/\s+/g, ' ').trim();
    if (s && !seen.has(s.toLowerCase())) {
      seen.add(s.toLowerCase());
      out.push(s);
    }
  }
  return out.join('\n');
}

function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^(www|m|mobile)\./, '');
  } catch {
    return 'That site';
  }
}

function redirectTo(request: Request, path: string, params: Record<string, string | undefined>) {
  const url = new URL(path, request.url);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  return NextResponse.redirect(url, 303);
}

function errorRedirect(request: Request, message: string) {
  return redirectTo(request, '/app', { shareError: message });
}

// The Create form, prefilled with what was shared and a line saying what is
// still needed. The form's own submit then goes through /api/captures.
function submitRedirect(
  request: Request,
  fields: { url?: string; text?: string; notice: string }
) {
  return redirectTo(request, '/app/submit', {
    url: fields.url,
    text: fields.text?.slice(0, 1000),
    notice: fields.notice,
  });
}

function marketRedirect(request: Request, result: ProcessCaptureResult) {
  if (result.background) after(result.background);
  const target = result.marketId
    ? new URL(`/app/markets/${result.marketId}`, request.url)
    : new URL('/app', request.url);
  target.searchParams.set('shared', '1');
  return NextResponse.redirect(target, 303);
}

// The first non-empty file in the form. Chrome names it `image` per the
// manifest, but a defensive scan costs nothing.
function sharedFile(form: FormData): File | null {
  const named = form.get('image');
  if (named instanceof File && named.size > 0) return named;
  for (const [, v] of form.entries()) {
    if (v instanceof File && v.size > 0) return v;
  }
  return null;
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Multipart bodies are lost across a redirect, so we can't preserve the
    // capture through a sign-in round-trip. Send them home with a nudge.
    const url = new URL('/', request.url);
    url.searchParams.set('redirect', '/app');
    url.searchParams.set('shareError', 'Sign in to capture shared content.');
    return NextResponse.redirect(url, 303);
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorRedirect(request, 'Expected multipart/form-data');
  }

  const image = sharedFile(form);
  const rawTitle = (form.get('title') as string | null) ?? undefined;
  const rawText = (form.get('text') as string | null) ?? undefined;
  const rawUrl = (form.get('url') as string | null) ?? undefined;
  // Android/Chrome often packs the shared URL into `text` rather than `url`
  // (apps use ACTION_SEND with text/plain), and some apps put prose in
  // `url`. Scan every field for the first real URL.
  const linkUrl = firstUrl(rawUrl) || firstUrl(rawText) || firstUrl(rawTitle);
  const caption = captionOf(rawTitle, rawText, rawUrl);
  // A title that is just the site name adds nothing the URL does not.
  const pageTitle = rawTitle && !firstUrl(rawTitle) ? rawTitle.trim() || undefined : undefined;

  console.log('[share] received', {
    hasImage: Boolean(image),
    imageType: image?.type ?? null,
    imageSize: image?.size ?? null,
    rawTitle,
    rawText,
    rawUrl,
    linkUrl,
    captionLength: caption.length,
  });

  try {
    // 1. Screenshot: the reliable path, straight to the model.
    if (image) {
      const buffer = Buffer.from(await image.arrayBuffer());
      const result = await processCapture({
        imageBase64: buffer.toString('base64'),
        mediaType: toMediaType(image.type),
        sourceUrl: linkUrl,
        pageTitle,
        pageContext: caption || undefined,
        supabase,
        userId: user.id,
      });
      return marketRedirect(request, result);
    }

    // 2. Link: dedup on the URL first so a repeat skips the fetch, then the
    //    preview image, then the caption, then hand over to the form.
    if (linkUrl) {
      const hash = contentHash({ url: linkUrl });
      const earlier = await findByHash(hash);
      if (earlier) return marketRedirect(request, earlier);
      const earlierReject = await findEarlierRejection(hash);
      if (earlierReject) throw new SubmissionRejectedError(earlierReject);

      let fetchReason: string | null = null;
      try {
        const fetched = await fetchImageFromUrl(linkUrl);
        const result = await processCapture({
          imageBase64: fetched.imageBase64,
          mediaType: fetched.mediaType,
          sourceUrl: linkUrl,
          // Prefer what the page says about itself; the share sheet's title
          // is often just the app name.
          pageTitle: fetched.pageTitle ?? pageTitle,
          pageContext: [fetched.pageContext, caption].filter(Boolean).join('\n') || undefined,
          contentHash: hash,
          supabase,
          userId: user.id,
        });
        return marketRedirect(request, result);
      } catch (err) {
        if (err instanceof SubmissionRejectedError) throw err;
        fetchReason =
          err instanceof OgFetchError ? err.reason : (err as Error).message || 'Unknown fetch error';
        console.warn('[share] link preview failed', { linkUrl, reason: fetchReason });
      }

      const host = hostLabel(linkUrl);
      // A caption of a few words ("Andrew Tate", a headline) is often enough
      // for the text model. Anything shorter is app boilerplate.
      if (caption.length >= 8) {
        try {
          const result = await processCapture({
            text: caption,
            sourceUrl: linkUrl,
            pageTitle,
            supabase,
            userId: user.id,
          });
          return marketRedirect(request, result);
        } catch (err) {
          if (!(err instanceof SubmissionRejectedError)) throw err;
          return submitRedirect(request, {
            url: linkUrl,
            text: caption,
            notice: `${host} would not give a preview (${fetchReason}) and the caption alone was not enough. Add a screenshot of the post and submit.`,
          });
        }
      }
      return submitRedirect(request, {
        url: linkUrl,
        text: caption || undefined,
        notice: `${host} would not give a preview (${fetchReason}). Add a screenshot of the post and submit.`,
      });
    }

    // 3. Plain text.
    if (caption.trim()) {
      try {
        const result = await processCapture({
          text: caption,
          pageTitle,
          supabase,
          userId: user.id,
        });
        return marketRedirect(request, result);
      } catch (err) {
        if (!(err instanceof SubmissionRejectedError)) throw err;
        return submitRedirect(request, {
          text: caption,
          notice: `${err.message} Add a screenshot or a link and submit.`,
        });
      }
    }

    return submitRedirect(request, {
      notice: 'Nothing usable arrived in the share. Add a screenshot, a link, or some text.',
    });
  } catch (err) {
    if (err instanceof SubmissionRejectedError) {
      return submitRedirect(request, {
        url: linkUrl,
        text: caption || undefined,
        notice: err.message,
      });
    }
    console.error('[share POST] failed', err);
    return errorRedirect(request, (err as Error).message || 'Capture failed');
  }
}
