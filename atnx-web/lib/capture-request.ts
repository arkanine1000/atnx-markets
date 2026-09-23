import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from './supabase/database';
import {
  contentHash,
  findByHash,
  findEarlierRejection,
  SubmissionRejectedError,
  toMediaType,
  type ProcessCaptureInput,
  type ProcessCaptureResult,
} from './capture';
import { fetchImageFromUrl, OgFetchError } from './og';
import { ReviewError } from './review';

// The multipart body /api/captures and /api/captures/propose accept, turned
// into pipeline input. Shared so both routes read a request the same way.
//
//   image  File               screenshot or photo
//   url    string             a link; the og:image is fetched server-side
//   text   string             a line of text
// plus optional sourceUrl, pageTitle, pageContext. An image wins over a url,
// a url over bare text; the others ride along as context.

// Hosts that block server-side fetches. When the OG fetch fails for one of
// these, the answer is "paste a screenshot", not an error.
const SCREENSHOT_ONLY_HOSTS =
  /(^|\.)(x\.com|twitter\.com|tiktok\.com|instagram\.com|threads\.net|threads\.com|facebook\.com|fb\.com|fb\.watch)$/i;

export type CaptureRequest =
  | { kind: 'input'; input: ProcessCaptureInput }
  // A URL seen before: answered without fetching or proposing anything.
  | { kind: 'final'; result: ProcessCaptureResult }
  | { kind: 'error'; status: number; body: Record<string, unknown> };

export async function readCaptureRequest(
  request: Request,
  ctx: { supabase: SupabaseClient<Database>; userId: string }
): Promise<CaptureRequest> {
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return { kind: 'error', status: 400, body: { success: false, error: 'Expected multipart/form-data' } };
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
    return { kind: 'error', status: 400, body: { success: false, error: 'Send an image, a url, or text' } };
  }

  const input: ProcessCaptureInput = {
    text,
    sourceUrl: str('sourceUrl'),
    pageTitle: str('pageTitle'),
    pageContext: str('pageContext'),
    supabase: ctx.supabase,
    userId: ctx.userId,
  };

  if (hasImage) {
    input.mediaType = toMediaType(image.type);
    input.imageBase64 = Buffer.from(await image.arrayBuffer()).toString('base64');
    return { kind: 'input', input };
  }
  if (!url) return { kind: 'input', input };

  // Dedup on the URL before fetching anything.
  const hash = contentHash({ url });
  const earlier = await findByHash(hash);
  if (earlier) return { kind: 'final', result: earlier };
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
      return {
        kind: 'error',
        status: 422,
        body: {
          success: false,
          outcome: 'needs_image',
          error: `${host.replace(/^www\./, '')} blocks link previews. Paste a screenshot of the post instead.`,
        },
      };
    }
    return { kind: 'error', status: 400, body: { success: false, error: `Couldn't fetch that link: ${reason}` } };
  }
  return { kind: 'input', input };
}

// The JSON body of a finished capture, as every capture route reports it.
export function successBody(result: ProcessCaptureResult) {
  return {
    success: true as const,
    final: true as const,
    marketId: result.marketId,
    entityName: result.entityName,
    isNew: result.isNew,
    outcome: result.outcome,
    review: result.review,
    vi: result.vi,
    // True when the VI sources are still being fetched after this response;
    // the market's score lands a few seconds later.
    viPending: result.viPending,
    source: result.source,
  };
}

// One place that turns pipeline errors into responses.
export function captureErrorResponse(err: unknown, headers: Record<string, string>, where: string): Response {
  if (err instanceof SubmissionRejectedError) {
    return Response.json(
      { success: false, outcome: 'rejected', reason: err.reason, error: err.message },
      { status: 422, headers }
    );
  }
  if (err instanceof ReviewError) {
    return Response.json(
      { success: false, outcome: 'review_error', code: err.code, error: err.message },
      { status: err.status, headers }
    );
  }
  console.error(`[${where}] failed`, err);
  return Response.json({ success: false, error: (err as Error).message }, { status: 500, headers });
}
