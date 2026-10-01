import { createAdminClient } from '@/lib/supabase/admin';
import { corsHeaders, corsPreflight } from '@/lib/cors';
import { listAll, listLive } from '@/lib/bm/registry';
import { BM_CHAINS } from '@/lib/bm/chains';
import type { BmMarketListing } from '@/lib/bm/listing';

// The bounded markets, joined with the atnx market they sit on. Public,
// CORS-enabled: the portfolio page and the extension read it.
//   ?state=live (default)  pending, open and resolving rows
//   ?state=all             the last 200 rows, resolved ones included


export async function GET(request: Request) {
  const headers = corsHeaders(request);
  const all = new URL(request.url).searchParams.get('state') === 'all';
  try {
    const rows = all ? await listAll(200) : await listLive();
    const ids = Array.from(new Set(rows.map((r) => r.atnx_market_id)));
    const names = new Map<string, { name: string; thumb: string | null; vi: number }>();
    if (ids.length) {
      const { data, error } = await createAdminClient()
        .from('markets')
        .select('id, entity_name, thumbnail_url, current_vi')
        .in('id', ids);
      if (error) throw error;
      for (const m of data ?? []) {
        names.set(m.id, { name: m.entity_name, thumb: m.thumbnail_url, vi: Number(m.current_vi ?? 0) });
      }
    }
    const items: BmMarketListing[] = rows.map((r) => {
      const m = names.get(r.atnx_market_id);
      const chain = BM_CHAINS[r.chain as keyof typeof BM_CHAINS];
      return {
        id: r.id,
        atnxMarketId: r.atnx_market_id,
        name: m?.name ?? 'Unknown market',
        thumbnailUrl: m?.thumb ?? null,
        currentVi: m?.vi ?? 0,
        chain: r.chain,
        chainLabel: chain?.label ?? r.chain,
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
    return Response.json({ items }, { headers: { ...headers, 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30' } });
  } catch (err) {
    console.error('[bm markets GET] failed', err);
    return Response.json({ items: [], error: (err as Error).message }, { status: 500, headers });
  }
}

export async function OPTIONS(request: Request) {
  return corsPreflight(request);
}
