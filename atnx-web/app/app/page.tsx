import { getMarketsPage, type MarketsPage } from "@/lib/store";
import { PAGE_SIZE, parseMarketsQuery } from "@/lib/markets-query";
import { MarketsView } from "./MarketsView";

// Rendered on the server with the page already in it, so the first paint
// has the hero and the grid instead of "0 live markets" and a fetch.
// The client view then keeps polling the same page.
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
    page: query.page,
    pageSize: PAGE_SIZE,
  };
  try {
    data = await getMarketsPage(query);
  } catch (err) {
    // The client poll will pick the page up; an empty first paint is
    // better than an error page.
    console.error("[markets] initial page failed", err);
  }
  // Keyed on the query so a navigation starts the client state afresh.
  return (
    <MarketsView
      key={`${query.sort}:${query.page}:${query.q}`}
      initial={data}
      sort={query.sort}
      page={query.page}
      q={query.q}
    />
  );
}
