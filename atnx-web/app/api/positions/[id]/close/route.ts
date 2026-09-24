import { createClient } from '@/lib/supabase/server';
import { corsHeaders, corsPreflight } from '@/lib/cors';
import { closePositionFor } from '@/lib/trading';

// Closes one of the caller's open positions, for the extension's side
// panel. No body. Answers { success, realizedPnl, exitVi, liquidated } the
// way the site's own close does (lib/trading.ts); a position that is not
// the caller's, or is already closed, is 404. Auth is the Supabase cookie.

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const headers = corsHeaders(request);
  const { id } = await params;

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) {
    return Response.json({ success: false, error: 'Not signed in' }, { status: 401, headers });
  }

  try {
    const result = await closePositionFor(supabase, id);
    const status = result.success ? 200 : result.error === 'Position not found' ? 404 : 400;
    return Response.json(result, { status, headers });
  } catch (err) {
    console.error('[positions close POST] failed', err);
    return Response.json(
      { success: false, error: (err as Error).message },
      { status: 500, headers }
    );
  }
}

export async function OPTIONS(request: Request) {
  return corsPreflight(request);
}
