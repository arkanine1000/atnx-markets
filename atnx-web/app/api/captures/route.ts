import { after } from 'next/server';
import { getCaptures } from '@/lib/store';
import { processCapture } from '@/lib/capture';
import { captureErrorResponse, readCaptureRequest, successBody } from '@/lib/capture-request';
import { createClient } from '@/lib/supabase/server';
import { corsHeaders, corsPreflight } from '@/lib/cors';

// Bounds the model call plus the after() work (VI scoring, and the retry
// for a low-confidence create). The response itself goes out as soon as the
// capture is identified and saved.
export const maxDuration = 60;

// The one-shot path: propose and commit the default choice in one call.
// The web form, the share sheet and the extension go through
// /api/captures/propose and /commit instead so the submitter can review
// first; this stays for the eval script and older clients. The body is the
// multipart form lib/capture-request.ts describes.
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

  try {
    const req = await readCaptureRequest(request, { supabase, userId: user.id });
    if (req.kind === 'error') return Response.json(req.body, { status: req.status, headers });
    if (req.kind === 'final') return Response.json(successBody(req.result), { headers });

    const result = await processCapture(req.input);
    if (result.background) after(result.background);

    return Response.json(successBody(result), { headers });
  } catch (err) {
    return captureErrorResponse(err, headers, 'captures POST');
  }
}

// The feed is the same for every viewer and the dashboard polls it every
// thirty seconds, so let the CDN answer the polls: fresh for 15 s, served
// stale for up to 45 s more while one request refreshes it. Behind that,
// getCaptures() shares one database read across callers for the same 15 s.
const FEED_CACHE = 'public, s-maxage=15, stale-while-revalidate=45';

export async function GET(request: Request) {
  const headers = corsHeaders(request);
  try {
    const captures = await getCaptures();
    return Response.json({ captures }, { headers: { ...headers, 'Cache-Control': FEED_CACHE } });
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
