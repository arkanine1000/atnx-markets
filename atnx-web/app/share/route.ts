import { NextResponse } from 'next/server';
import { processCapture, toMediaType } from '@/lib/capture';
import { fetchImageFromUrl } from '@/lib/og';
import { createClient } from '@/lib/supabase/server';
import type { VisionMediaType } from '@/lib/claude-vision';

// Android share target. The manifest registers /share with method=POST and
// enctype=multipart/form-data; picking ATNX from the share sheet POSTs
// {title, text, url, image} here. We run the same pipeline as /api/captures
// and redirect to the new market so the PWA feels native on Android.
//
// Two share flows are supported:
//   1. Image share (e.g. screenshot from gallery): `image` file present.
//   2. Link share (Twitter, TikTok, IG, YouTube, etc): only `url`/`text`
//      present — we scrape og:image and feed that through the same pipeline.

export const maxDuration = 30;

function firstUrl(text: string | null | undefined): string | undefined {
  if (!text) return undefined;
  const m = /https?:\/\/[^\s<>"]+/i.exec(text);
  return m?.[0];
}

function errorRedirect(request: Request, message: string) {
  const url = new URL('/app', request.url);
  url.searchParams.set('shareError', message);
  return NextResponse.redirect(url, 303);
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

  const image = form.get('image');
  const rawTitle = (form.get('title') as string | null) ?? undefined;
  const rawText = (form.get('text') as string | null) ?? undefined;
  const rawUrl = (form.get('url') as string | null) ?? undefined;
  // Android/Chrome often packs the shared URL into `text` rather than `url`
  // (e.g. when apps use ACTION_SEND with text/plain). Fall back to scanning.
  const linkUrl = rawUrl || firstUrl(rawText) || firstUrl(rawTitle);

  let imageBase64: string | undefined;
  let mediaType: VisionMediaType | undefined;
  let sourceUrl = rawUrl || linkUrl;
  let pageTitle = rawTitle;
  let pageContext = rawText;

  if (image instanceof File && image.size > 0) {
    mediaType = toMediaType(image.type);
    const buffer = Buffer.from(await image.arrayBuffer());
    imageBase64 = buffer.toString('base64');
  } else if (linkUrl) {
    const fetched = await fetchImageFromUrl(linkUrl);
    if (!fetched) {
      return errorRedirect(
        request,
        "Couldn't find an image for that link — try sharing a screenshot instead."
      );
    }
    imageBase64 = fetched.imageBase64;
    mediaType = fetched.mediaType;
    sourceUrl = linkUrl;
    // Prefer OG-derived title/description; fall back to whatever the share
    // sheet supplied (often just the URL).
    pageTitle = fetched.pageTitle ?? pageTitle;
    pageContext = fetched.pageContext ?? pageContext;
  } else {
    return errorRedirect(request, 'No image or link in shared content');
  }

  try {
    const result = await processCapture({
      imageBase64,
      mediaType,
      sourceUrl,
      pageTitle,
      pageContext,
      supabase,
      userId: user.id,
    });

    const target = result.marketId
      ? new URL(`/app/markets/${result.marketId}`, request.url)
      : new URL('/app', request.url);
    target.searchParams.set('shared', '1');
    return NextResponse.redirect(target, 303);
  } catch (err) {
    console.error('[share POST] failed', err);
    return errorRedirect(request, (err as Error).message || 'Capture failed');
  }
}
