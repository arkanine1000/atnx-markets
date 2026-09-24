import { createClient } from '@/lib/supabase/server';
import { corsHeaders, corsPreflight } from '@/lib/cors';
import { openPositionFor } from '@/lib/trading';

// Opens a position for the Chrome extension's side panel, which trades
// from the top-markets list without leaving for the site. JSON body
// { marketId, direction: 'long' | 'short', sizeUsd, leverage? }. Auth is
// the Supabase cookie (attached cross-origin via `credentials: 'include'`),
// so a signed-out caller gets 401. The checks and the database call are
// the same as the site's own trade ticket (lib/trading.ts); a rule the
// database refuses (insufficient balance, a market with no score yet)
// comes back as 400 with its message.

export async function POST(request: Request) {
  const headers = corsHeaders(request);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ success: false, error: 'Not signed in' }, { status: 401, headers });
  }

  let body: { marketId?: unknown; direction?: unknown; sizeUsd?: unknown; leverage?: unknown };
  try {
    body = await request.json();
  } catch {
    return Response.json({ success: false, error: 'Expected JSON' }, { status: 400, headers });
  }
  if (typeof body.marketId !== 'string' || !body.marketId) {
    return Response.json({ success: false, error: 'marketId is required' }, { status: 400, headers });
  }

  try {
    const result = await openPositionFor(supabase, {
      marketId: body.marketId,
      direction: body.direction as 'long' | 'short',
      sizeUsd: Number(body.sizeUsd),
      leverage: body.leverage === undefined ? 1 : Number(body.leverage),
    });
    return Response.json(result, { status: result.success ? 200 : 400, headers });
  } catch (err) {
    console.error('[positions POST] failed', err);
    return Response.json(
      { success: false, error: (err as Error).message },
      { status: 500, headers }
    );
  }
}

export async function OPTIONS(request: Request) {
  return corsPreflight(request);
}
