import { NextResponse } from 'next/server';
import { processCapture, toMediaType } from '@/lib/capture';
import { createClient } from '@/lib/supabase/server';

// Android share target. The manifest registers /share with method=POST and
// enctype=multipart/form-data; picking ATNX from the share sheet POSTs
// {title, text, url, image} here. We run the same pipeline as /api/captures
// and redirect to the new market so the PWA feels native on Android.

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
  if (!(image instanceof File) || image.size === 0) {
    return errorRedirect(request, 'No image in shared content');
  }

  const sourceUrl = (form.get('url') as string | null) ?? undefined;
  const pageTitle = (form.get('title') as string | null) ?? undefined;
  const pageContext = (form.get('text') as string | null) ?? undefined;

  const mediaType = toMediaType(image.type);
  const buffer = Buffer.from(await image.arrayBuffer());
  const imageBase64 = buffer.toString('base64');

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
