import { getCaptures } from "@/lib/store";
import { MarketsView } from "./MarketsView";

// Rendered on the server with the feed already in it, so the first paint
// has the hero and the grid instead of "0 live markets" and a fetch.
// The client view then keeps polling.
export const dynamic = "force-dynamic";

export default async function MarketsPage() {
  let captures: Awaited<ReturnType<typeof getCaptures>> = [];
  try {
    captures = await getCaptures();
  } catch (err) {
    // The client poll will pick the feed up; an empty first paint is
    // better than an error page.
    console.error("[markets] initial feed failed", err);
  }
  return <MarketsView initialCaptures={captures} />;
}
