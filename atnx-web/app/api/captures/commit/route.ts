import { after } from 'next/server';
import { captureErrorResponse, successBody } from '@/lib/capture-request';
import { commitDraft, loadDraft } from '@/lib/capture';
import { validateChoice } from '@/lib/review';
import { createClient } from '@/lib/supabase/server';
import { corsHeaders, corsPreflight } from '@/lib/cors';

// Second half of the review step. JSON body: { draftId, choice }, where
// choice is one of the options the draft offered (lib/review.ts
// validateChoice). Persists the capture and, when chosen, the market; the
// VI scoring runs after the response.
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

  let body: { draftId?: unknown; choice?: unknown };
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
    const choice = validateChoice(draft, body.choice);
    const result = await commitDraft(draft, { supabase, userId: user.id, choice, persisted: true });
    if (result.background) after(result.background);
    return Response.json(successBody(result), { headers });
  } catch (err) {
    return captureErrorResponse(err, headers, 'captures/commit POST');
  }
}

export async function OPTIONS(request: Request) {
  return corsPreflight(request);
}
