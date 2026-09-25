import { getMarketsPage } from '@/lib/store';
import { parseMarketsQuery } from '@/lib/markets-query';
import { corsHeaders, corsPreflight } from '@/lib/cors';

// One page of the dashboard's market listing plus the hero's featured set,
// sorted in the database. The dashboard polls this for the page it has
// open; the extension reads its top markets from here too. It used to rank
// the 50 newest captures, so a market whose captures were older (Google,
// VI #1) fell out of its list altogether.
const FEED_CACHE = 'public, s-maxage=15, stale-while-revalidate=45';

export async function GET(request: Request) {
  const headers = corsHeaders(request);
  const query = parseMarketsQuery(new URL(request.url).searchParams);
  try {
    const page = await getMarketsPage(query);
    return Response.json(page, { headers: { ...headers, 'Cache-Control': FEED_CACHE } });
  } catch (err) {
    console.error('[markets GET] failed to load', err);
    return Response.json(
      { items: [], featured: [], total: 0, page: query.page, pageSize: 0, error: (err as Error).message },
      { status: 500, headers }
    );
  }
}

export async function OPTIONS(request: Request) {
  return corsPreflight(request);
}
