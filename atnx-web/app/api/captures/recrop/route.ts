import { captureErrorResponse, successBody } from '@/lib/capture-request';
import { loadDraft, recropDraft } from '@/lib/capture';
import { createClient } from '@/lib/supabase/server';
import { corsHeaders, corsPreflight } from '@/lib/cors';

// Re-crop a draft's image. JSON body: { draftId, crop: {x, y, width,
// height} } in original-image pixels. The server crops its own copy, runs
// the model once more and answers with the rewritten draft. Two per draft.
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

  let body: { draftId?: unknown; crop?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Expected JSON' }, { status: 400, headers });
  }
  if (typeof body.draftId !== 'string') {
    return Response.json({ success: false, error: 'draftId is required' }, { status: 400, headers });
  }

  try {
    const draft = await loadDraft(body.draftId, user.id);
    const outcome = await recropDraft(draft, body.crop);
    if (outcome.kind === 'final') return Response.json(successBody(outcome.result), { headers });
    return Response.json({ success: true, final: false, draft: outcome.view }, { headers });
  } catch (err) {
    return captureErrorResponse(err, headers, 'captures/recrop POST');
  }
}

export async function OPTIONS(request: Request) {
  return corsPreflight(request);
}
