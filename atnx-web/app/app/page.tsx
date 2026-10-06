import { getMarketsPage, type MarketsPage } from "@/lib/store";
import { parseMarketsQuery } from "@/lib/markets-query";
import { MarketsView, type BoundsMap, type RoundsMap } from "./MarketsView";
import { listLive } from "@/lib/bm/registry";
import { isRoundsDeployed } from "@/lib/bm/chains";
import { listLiveRounds } from "@/lib/bm/rounds-registry";

// Rendered on the server with the listing already in it, so the first paint
// has the hero and the grid instead of "0 live markets" and a fetch.
// The client view then keeps polling the same listing.
export const dynamic = "force-dynamic";

export default async function MarketsPage({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}) {
  const query = parseMarketsQuery(await searchParams);
  let data: MarketsPage = {
    items: [],
    featured: [],
    total: 0,
    limit: query.limit,
    categoryCounts: {},
  };
  const bounded: BoundsMap = {};
  const rounds: RoundsMap = {};
  try {
    const [page, live, liveRounds] = await Promise.all([
      getMarketsPage(query),
      // Bounded markets no longer badge the list once rounds are deployed.
      isRoundsDeployed()
        ? Promise.resolve([])
        : listLive().catch((err) => {
            console.error("[markets] bounded list failed", err);
            return [];
          }),
      listLiveRounds().catch((err) => {
        console.error("[markets] rounds list failed", err);
        return [];
      }),
    ]);
    data = page;
    for (const r of live) {
      // One badge per market: the first live row wins (chains rarely differ).
      bounded[r.atnx_market_id] ??= { lower: r.lower_bound, upper: r.upper_bound };
    }
    // One round badge per market: a round in flight beats a presale, the
    // daily series beats the fast demo one.
    const rank = (r: (typeof liveRounds)[number]) => (r.state === "presale" ? 2 : 0) + (r.series.fast ? 1 : 0);
    for (const r of [...liveRounds].sort((a, b) => rank(a) - rank(b))) {
      rounds[r.series.atnx_market_id] ??= {
        idx: r.idx,
        state: r.state,
        target: r.target_vi,
        closeAt: r.close_at,
        tradeUntil: r.trade_until,
        opensAt: r.opens_at,
        fast: r.series.fast,
      };
    }
  } catch (err) {
    // The client poll will pick the listing up; an empty first paint is
    // better than an error page.
    console.error("[markets] initial page failed", err);
  }
  // Not keyed on the query: a remount would close the category filter's
  // menu on every tick. The view starts afresh from each new listing itself.
  return <MarketsView initial={data} query={query} bounded={bounded} rounds={rounds} />;
}
