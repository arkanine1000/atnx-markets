import { notFound } from "next/navigation";
import { getMarketDetail } from "@/lib/store";
import { MarketDetailClient } from "./market-detail";

export const dynamic = "force-dynamic";

export default async function MarketPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const detail = await getMarketDetail(id);
  if (!detail) notFound();

  return (
    <MarketDetailClient
      market={detail.market}
      captures={detail.captures}
      trends={detail.trends}
    />
  );
}
