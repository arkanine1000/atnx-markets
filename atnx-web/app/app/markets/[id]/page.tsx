import { notFound } from "next/navigation";
import { createAdminClient } from "@/lib/supabase/admin";
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

  const admin = createAdminClient();
  const { count } = await admin
    .from("captures")
    .select("id", { count: "exact", head: true })
    .is("deleted_at", null);

  return (
    <MarketDetailClient
      market={detail.market}
      captures={detail.captures}
      trends={detail.trends}
      captureCount={count ?? 0}
    />
  );
}
