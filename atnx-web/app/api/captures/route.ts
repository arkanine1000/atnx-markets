import { addCapture, getCaptures, type Capture } from '@/lib/store';
import { fetchTrendsData, normalizeSearchTerm } from '@/lib/trends';
import { createClient } from '@/lib/supabase/server';

// CORS with credentials requires echoing the caller's Origin (not `*`) so the
// Chrome extension's auth cookie is accepted on cross-origin requests.
function corsHeaders(request: Request): Record<string, string> {
  const origin = request.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Credentials': 'true',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    Vary: 'Origin',
  };
}

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

  const data = await request.json();

  const searchTerm = normalizeSearchTerm(data.analysis);

  let trendsData = null;
  if (searchTerm.length > 1) {
    trendsData = await fetchTrendsData(searchTerm);
  }

  const input: Capture = {
    id: data.id || Date.now().toString(),
    timestamp: data.timestamp || new Date().toISOString(),
    pageUrl: data.pageUrl,
    pageTitle: data.pageTitle,
    screenshot: data.screenshot,
    analysis: data.analysis,
    trends: trendsData,
    viralityScore: trendsData?.viralityScore ?? 0,
  };

  try {
    const saved = await addCapture(input, supabase, user.id);
    return Response.json(
      { success: true, id: saved.id, viralityScore: saved.viralityScore },
      { headers }
    );
  } catch (err) {
    console.error('[captures POST] failed to persist', err);
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
  return new Response(null, { status: 204, headers: corsHeaders(request) });
}
