import { getMarketsPage } from '@/lib/store';
import { parseMarketsQuery } from '@/lib/markets-query';

// One page of the dashboard's market listing plus the hero's featured set.
// The dashboard polls this for the page it has open; the extension keeps
// reading /api/captures.
const FEED_CACHE = 'public, s-maxage=15, stale-while-revalidate=45';

export async function GET(request: Request) {
  const query = parseMarketsQuery(new URL(request.url).searchParams);
  try {
    const page = await getMarketsPage(query);
    return Response.json(page, { headers: { 'Cache-Control': FEED_CACHE } });
  } catch (err) {
    console.error('[markets GET] failed to load', err);
    return Response.json(
      { items: [], featured: [], total: 0, page: query.page, pageSize: 0, error: (err as Error).message },
      { status: 500 }
    );
  }
}
