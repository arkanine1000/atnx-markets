import { readCaptureRequest, captureErrorResponse, successBody } from '@/lib/capture-request';
import { proposeCapture } from '@/lib/capture';
import { createClient } from '@/lib/supabase/server';
import { corsHeaders, corsPreflight } from '@/lib/cors';

// First half of the review step. Takes the same multipart body as
// /api/captures, runs the pipeline up to the routing decision and answers
// with a draft for the submitter to review (see lib/review.ts), or with a
// finished result when the same bytes or URL were captured before.
export const maxDuration = 60;

export async function POST(request: Request) {
  const headers = corsHeaders(request);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ success: false, error: 'Not signed in' }, { status: 401, headers });
  }

  try {
    const req = await readCaptureRequest(request, { supabase, userId: user.id });
    if (req.kind === 'error') return Response.json(req.body, { status: req.status, headers });
    if (req.kind === 'final') return Response.json(successBody(req.result), { headers });

    const proposed = await proposeCapture(req.input, { persist: true });
    if (proposed.kind === 'final') return Response.json(successBody(proposed.result), { headers });
    return Response.json({ success: true, final: false, draft: proposed.view }, { headers });
  } catch (err) {
    return captureErrorResponse(err, headers, 'captures/propose POST');
  }
}

export async function OPTIONS(request: Request) {
  return corsPreflight(request);
}
