import { createClient } from '@/lib/supabase/server';
import { corsHeaders, corsPreflight } from '@/lib/cors';

// Who the cookie belongs to, for the extension's side panel: it used to
// learn this from /api/portfolio, which is gone with the simulated
// exchange. 401 when signed out.
export async function GET(request: Request) {
  const headers = corsHeaders(request);
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: 'Not signed in' }, { status: 401, headers });
  const { data: profile } = await supabase
    .from('user_profiles')
    .select('handle, role')
    .eq('id', user.id)
    .maybeSingle();
  return Response.json(
    {
      userId: user.id,
      handle: profile?.handle ?? null,
      isAdmin: profile?.role === 'admin' || profile?.role === 'moderator',
    },
    { headers: { ...headers, 'Cache-Control': 'private, no-store' } }
  );
}

export async function OPTIONS(request: Request) {
  return corsPreflight(request);
}
