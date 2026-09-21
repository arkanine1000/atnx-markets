import { after } from 'next/server';
import { getCaptures } from '@/lib/store';
import {
  contentHash,
  findByHash,
  findEarlierRejection,
  processCapture,
  SubmissionRejectedError,
  toMediaType,
  type ProcessCaptureInput,
} from '@/lib/capture';
import { fetchImageFromUrl, OgFetchError } from '@/lib/og';
import { createClient } from '@/lib/supabase/server';
import { corsHeaders, corsPreflight } from '@/lib/cors';

// Bounds the model call plus, when scheduled, the after() retry.
export const maxDuration = 60;

// Hosts that block server-side fetches. When the OG fetch fails for one of
// these, the answer is "paste a screenshot", not an error.
const SCREENSHOT_ONLY_HOSTS = /(^|\.)(x\.com|twitter\.com|tiktok\.com|instagram\.com|threads\.net)$/i;

function successBody(result: Awaited<ReturnType<typeof processCapture>>) {
  return {
    success: true,
    marketId: result.marketId,
    entityName: result.entityName,
    isNew: result.isNew,
    outcome: result.outcome,
    review: result.review,
    vi: result.vi,
    source: result.source,
  };
}

// Accepts multipart/form-data with at least one of:
//   image  File               screenshot or photo
//   url    string             a link; the og:image is fetched server-side
//   text   string             a line of text
// plus optional sourceUrl, pageTitle, pageContext. An image wins over a url,
// a url over bare text; the others ride along as context.
export async function POST(request: Request) {
  const headers = corsHeaders(request);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json(
      { success: false, error: 'Not signed in' },
      { status: 401, headers }
    );
  }

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { success: false, error: 'Expected multipart/form-data' },
      { status: 400, headers }
    );
  }

  const str = (key: string) => {
    const v = form.get(key);
    return typeof v === 'string' && v.trim() ? v.trim() : undefined;
  };
  const image = form.get('image');
  const hasImage = image instanceof File && image.size > 0;
  const url = str('url');
  const text = str('text');

  if (!hasImage && !url && !text) {
    return Response.json(
      { success: false, error: 'Send an image, a url, or text' },
      { status: 400, headers }
    );
  }

  const input: ProcessCaptureInput = {
    text,
    sourceUrl: str('sourceUrl'),
    pageTitle: str('pageTitle'),
    pageContext: str('pageContext'),
    supabase,
    userId: user.id,
  };

  try {
    if (hasImage) {
      input.mediaType = toMediaType(image.type);
      input.imageBase64 = Buffer.from(await image.arrayBuffer()).toString('base64');
    } else if (url) {
      // Dedup on the URL before fetching anything.
      const hash = contentHash({ url });
      const earlier = await findByHash(hash);
      if (earlier) return Response.json(successBody(earlier), { headers });
      const earlierReject = await findEarlierRejection(hash);
      if (earlierReject) throw new SubmissionRejectedError(earlierReject);

      input.contentHash = hash;
      input.sourceUrl = input.sourceUrl ?? url;
      try {
        const fetched = await fetchImageFromUrl(url);
        input.imageBase64 = fetched.imageBase64;
        input.mediaType = fetched.mediaType;
        input.pageTitle = input.pageTitle ?? fetched.pageTitle;
        input.pageContext = input.pageContext ?? fetched.pageContext;
      } catch (err) {
        const reason = err instanceof OgFetchError ? err.reason : (err as Error).message;
        let host = '';
        try {
          host = new URL(url).hostname;
        } catch {
          // fall through with empty host
        }
        if (SCREENSHOT_ONLY_HOSTS.test(host)) {
          return Response.json(
            {
              success: false,
              outcome: 'needs_image',
              error: `${host.replace(/^www\./, '')} blocks link previews. Paste a screenshot of the post instead.`,
            },
            { status: 422, headers }
          );
        }
        return Response.json(
          { success: false, error: `Couldn't fetch that link: ${reason}` },
          { status: 400, headers }
        );
      }
    }

    const result = await processCapture(input);
    if (result.retry) after(result.retry);

    return Response.json(successBody(result), { headers });
  } catch (err) {
    if (err instanceof SubmissionRejectedError) {
      return Response.json(
        { success: false, outcome: 'rejected', reason: err.reason, error: err.message },
        { status: 422, headers }
      );
    }
    console.error('[captures POST] failed', err);
    return Response.json(
      { success: false, error: (err as Error).message },
      { status: 500, headers }
    );
  }
}

export async function GET(request: Request) {
  const headers = corsHeaders(request);
  try {
    const captures = await getCaptures();
    return Response.json({ captures }, { headers });
  } catch (err) {
    console.error('[captures GET] failed to load', err);
    return Response.json(
      { captures: [], error: (err as Error).message },
      { status: 500, headers }
    );
  }
}

export async function OPTIONS(request: Request) {
  return corsPreflight(request);
}
