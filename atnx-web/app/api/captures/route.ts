import { addCapture, getCaptures, type Capture } from '@/lib/store';
import { fetchTrendsData, normalizeSearchTerm } from '@/lib/trends';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

export async function POST(request: Request) {
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
    const saved = await addCapture(input);
    return Response.json(
      { success: true, id: saved.id, viralityScore: saved.viralityScore },
      { headers: CORS_HEADERS }
    );
  } catch (err) {
    console.error('[captures POST] failed to persist', err);
    return Response.json(
      { success: false, error: (err as Error).message },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

export async function GET() {
  try {
    const captures = await getCaptures();
    return Response.json({ captures }, { headers: CORS_HEADERS });
  } catch (err) {
    console.error('[captures GET] failed to load', err);
    return Response.json(
      { captures: [], error: (err as Error).message },
      { status: 500, headers: CORS_HEADERS }
    );
  }
}

export async function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS_HEADERS });
}
