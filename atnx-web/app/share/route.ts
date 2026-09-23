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
//
// An image share can also arrive with the image missing or empty: Chrome
// for Android 153 strips shared files from the POST, and a content URI
// whose grant lapsed leaves a zero-byte part. Those land on the Create
// form too, with the picker emphasised (?pick=1) and a notice that names
// the cause, since the person is one tap from finishing there.

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

// The service worker uploads on the user's behalf (public/sw.js) and asks
// for JSON: it cannot read the Location of a redirect, so it gets the
// path to move the window to instead. The share sheet's own POST, when no
// worker is in control yet, still gets the 303.
function wantsJson(request: Request): boolean {
  return (request.headers.get('accept') ?? '').includes('application/json');
}

function redirectTo(
  request: Request,
  path: string,
  params: Record<string, string | undefined>,
  extra: Record<string, unknown> = {}
) {
  const url = new URL(path, request.url);
  for (const [k, v] of Object.entries(params)) {
    if (v) url.searchParams.set(k, v);
  }
  if (wantsJson(request)) {
    return Response.json({ redirect: url.pathname + url.search, ...extra });
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

// `shared` carries the outcome so the market page can say what happened
// (new market, linked to an existing one, seen before).
function marketRedirect(request: Request, result: ProcessCaptureResult) {
  if (result.background) after(result.background);
  const path = result.marketId ? `/app/markets/${result.marketId}` : '/app';
  return redirectTo(request, path, { shared: result.outcome });
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

// A file part with no bytes: Chrome tried to send an image and lost it on
// the way (a revoked content URI, or the Chrome 153 share regression).
function emptyFile(form: FormData): File | null {
  for (const [, v] of form.entries()) {
    if (v instanceof File && v.size === 0) return v;
  }
  return null;
}

// The Create form with the picker emphasised: the image is what is missing.
function pickImageRedirect(
  request: Request,
  fields: { url?: string; text?: string; notice: string }
) {
  return redirectTo(request, '/app/submit', {
    url: fields.url,
    text: fields.text?.slice(0, 1000),
    notice: fields.notice,
    pick: '1',
  });
}

export async function POST(request: Request) {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    // Multipart bodies are lost across a redirect. The service worker,
    // told `signIn`, parks the capture and replays it after sign-in; a
    // bare POST with no worker in control is sent home with a nudge.
    return redirectTo(
      request,
      '/',
      { redirect: '/app', shareError: 'Sign in to capture shared content.' },
      { signIn: true }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return errorRedirect(request, 'Expected multipart/form-data');
  }

  const image = sharedFile(form);
  const empty = image ? null : emptyFile(form);
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
    emptyImage: empty ? { name: empty.name, type: empty.type } : null,
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

    // An image was meant to arrive and did not. Chrome for Android 153
    // strips shared files from the POST (the body has no parts at all, so
    // this also catches the no-part case below when nothing else came), and
    // a revoked content URI leaves a zero-byte part. The person is one tap
    // from finishing on the Create form; say what happened, not "nothing".
    if (empty) {
      return pickImageRedirect(request, {
        url: linkUrl,
        text: caption || undefined,
        notice: `The screenshot arrived empty (${empty.name || 'unnamed'}, ${empty.type || 'unknown type'}). Chrome for Android has a bug that drops shared images. Pick the screenshot below to finish.`,
      });
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

    // No file, no link, no text. A share sheet never sends an empty share,
    // so the image was dropped before it reached us: Chrome for Android 153
    // builds the POST with no parts at all.
    return pickImageRedirect(request, {
      notice:
        'The share arrived without the image. Chrome for Android 153 has a bug that drops shared screenshots. Pick the screenshot below to finish.',
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
