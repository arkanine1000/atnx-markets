import { notFound } from "next/navigation";
import { getMarketDetail } from "@/lib/store";
import { getBoundedMarkets } from "@/lib/bm/registry";
import { MarketDetailClient } from "./market-detail";

export const dynamic = "force-dynamic";
// The "Open UP/DOWN market" server action waits for a testnet receipt.
export const maxDuration = 60;

export default async function MarketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detail, bounded] = await Promise.all([
    getMarketDetail(id),
    getBoundedMarkets(id).catch((err) => {
      // The registry schema not being reachable must not take the page down.
      console.error("[market] bounded markets failed", err);
      return [];
    }),
  ]);
  if (!detail) notFound();

  return (
    <MarketDetailClient
      market={detail.market}
      neighbors={detail.neighbors}
      parent={detail.parent}
      childMarkets={detail.children}
      captures={detail.captures}
      trends={detail.trends}
      bounded={bounded}
    />
  );
}
