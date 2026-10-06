import { getMarketsPage } from '@/lib/store';
import { parseMarketsQuery } from '@/lib/markets-query';
import { corsHeaders, corsPreflight } from '@/lib/cors';
import { getRoundBadges, liveMarketIds, type RoundsMap } from '@/lib/bm/round-badges';

// The dashboard's market listing (the top `limit`, after any search and
// category filter) plus the hero's featured set, sorted in the database.
// The dashboard polls this for as many markets as it has shown; the
// extension reads its top markets from here too. It used to rank the 50
// newest captures, so a market whose captures were older (Google, VI #1)
// fell out of its list altogether. With `tab=live|next` (the dashboard's
// poll) it lists that tab only, with both tabs' counts and the round
// badges; without, every market, as the extension reads it.
const FEED_CACHE = 'public, s-maxage=15, stale-while-revalidate=45';

export async function GET(request: Request) {
  const headers = corsHeaders(request);
  const query = parseMarketsQuery(new URL(request.url).searchParams);
  try {
    if (!query.tab) {
      const page = await getMarketsPage(query);
      return Response.json(page, { headers: { ...headers, 'Cache-Control': FEED_CACHE } });
    }
    const rounds: RoundsMap = await getRoundBadges().catch((err) => {
      console.error('[markets GET] rounds list failed', err);
      return {};
    });
    const page = await getMarketsPage(query, liveMarketIds(rounds));
    return Response.json({ ...page, rounds }, { headers: { ...headers, 'Cache-Control': FEED_CACHE } });
  } catch (err) {
    console.error('[markets GET] failed to load', err);
    return Response.json(
      {
        items: [],
        featured: [],
        total: 0,
        limit: query.limit,
        categoryCounts: {},
        error: (err as Error).message,
      },
      { status: 500, headers }
    );
  }
}

export async function OPTIONS(request: Request) {
  return corsPreflight(request);
}
