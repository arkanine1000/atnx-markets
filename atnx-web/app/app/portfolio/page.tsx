import { loadMarketMeta } from "@/lib/bm/market-meta";
import { OnchainPortfolio } from "@/components/bm/OnchainPortfolio";
import { listAll } from "@/lib/bm/registry";
import { BM_CHAINS } from "@/lib/bm/chains";
import type { BmMarketListing } from "@/lib/bm/listing";

export const dynamic = "force-dynamic";

// The wallet's shares, read from the chain in the browser. The server
// only supplies the registry (which on-chain market belongs to which
// atnx market), so the list is right even when the wallet changes.
async function loadListing(): Promise<BmMarketListing[]> {
  try {
    const rows = await listAll(200);
    const ids = Array.from(new Set(rows.map((r) => r.atnx_market_id)));
    const names = await loadMarketMeta(ids);
    return rows.map((r) => {
      const m = names.get(r.atnx_market_id);
      return {
        id: r.id,
        atnxMarketId: r.atnx_market_id,
        name: m?.name ?? "Unknown market",
        thumbnailUrl: m?.thumb ?? null,
        currentVi: m?.vi ?? 0,
        chain: r.chain,
        chainLabel: BM_CHAINS[r.chain as keyof typeof BM_CHAINS]?.label ?? r.chain,
        contractAddress: r.contract_address,
        onchainMarketId: r.onchain_market_id,
        state: r.state,
        startVi: Number(r.start_vi),
        lower: Number(r.lower_bound),
        upper: Number(r.upper_bound),
        resolvedSide: r.resolved_side,
        resolvedVi: r.resolved_vi === null ? null : Number(r.resolved_vi),
        createdAt: r.created_at,
      };
    });
  } catch (err) {
    console.error("[portfolio] listing failed", err);
    return [];
  }
}

export default async function PortfolioPage() {
  const markets = await loadListing();
  return (
    <section>
      <div className="mb-5">
        <h2 className="font-display text-xl sm:text-2xl font-bold text-primary tracking-tight">Portfolio</h2>
      </div>
      <OnchainPortfolio markets={markets} />
    </section>
  );
}
