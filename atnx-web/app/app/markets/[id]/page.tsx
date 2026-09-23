import { notFound } from "next/navigation";
import { getMarketDetail, getMarketTradeLog } from "@/lib/store";
import { MarketDetailClient } from "./market-detail";

export const dynamic = "force-dynamic";

export default async function MarketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const [detail, tradeLog] = await Promise.all([
    getMarketDetail(id),
    getMarketTradeLog(id),
  ]);
  if (!detail) notFound();

  return (
    <MarketDetailClient
      market={detail.market}
      parent={detail.parent}
      childMarkets={detail.children}
      captures={detail.captures}
      trends={detail.trends}
      initialTradeLog={tradeLog}
      volumeUsd={detail.volumeUsd}
      tradeCount={detail.tradeCount}
    />
  );
}
