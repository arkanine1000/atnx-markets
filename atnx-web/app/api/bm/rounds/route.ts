import { loadMarketMeta } from '@/lib/bm/market-meta';
import { corsHeaders, corsPreflight } from '@/lib/cors';
import { getSeries, listLiveRounds, recentRounds } from '@/lib/bm/rounds-registry';
import type { BmRoundRow, BmSeriesRow } from '@/lib/supabase/database-bm';

// Rolling VI rounds, joined with the atnx market they run on. Public,
// CORS-enabled, like /api/bm/markets.
//   (default)          the presale and live rounds of every running series
//   ?series=<uuid>     that series' last 20 rounds, settled ones included

export interface RoundListing {
  seriesId: string;
  roundId: string;
  atnxMarketId: string;
  name: string;
  thumbnailUrl: string | null;
  currentVi: number;
  chain: string;
  idx: number;
  state: string;
  opensAt: string;
  closeAt: string | null;
  tradeUntil: string | null;
  targetVi: number | null;
  fast: boolean;
  finderWallet: string;
  settleVi?: number | null;
  settlePrints?: number | null;
  winner?: string | null;
}

const num = (v: number | string | null) => (v === null ? null : Number(v));

function shape(r: BmRoundRow, s: BmSeriesRow, meta: Awaited<ReturnType<typeof loadMarketMeta>>, settled: boolean): RoundListing {
  const m = meta.get(s.atnx_market_id);
  return {
    seriesId: s.id,
    roundId: r.id,
    atnxMarketId: s.atnx_market_id,
    name: m?.name ?? 'Unknown market',
    thumbnailUrl: m?.thumb ?? null,
    currentVi: m?.vi ?? 0,
    chain: s.chain,
    idx: r.idx,
    state: r.state,
    opensAt: r.opens_at,
    closeAt: r.close_at,
    tradeUntil: r.trade_until,
    targetVi: num(r.target_vi),
    fast: s.fast,
    finderWallet: s.finder_wallet,
    ...(settled ? { settleVi: num(r.settle_vi), settlePrints: r.settle_prints, winner: r.winner } : {}),
  };
}

export async function GET(request: Request) {
  const headers = corsHeaders(request);
  const seriesId = new URL(request.url).searchParams.get('series');
  try {
    let items: RoundListing[];
    if (seriesId) {
      if (!/^[0-9a-f-]{36}$/i.test(seriesId)) {
        return Response.json({ items: [], error: 'bad series id' }, { status: 400, headers });
      }
      const series = await getSeries(seriesId);
      if (!series) return Response.json({ items: [] }, { status: 404, headers });
      const [rounds, meta] = await Promise.all([recentRounds(series.id, 20), loadMarketMeta([series.atnx_market_id])]);
      items = rounds.map((r) => shape(r, series, meta, true));
    } else {
      const rows = await listLiveRounds();
      const meta = await loadMarketMeta(Array.from(new Set(rows.map((r) => r.series.atnx_market_id))));
      items = rows.map((r) => shape(r, r.series, meta, false));
    }
    return Response.json({ items }, { headers: { ...headers, 'Cache-Control': 'public, s-maxage=10, stale-while-revalidate=30' } });
  } catch (err) {
    console.error('[bm rounds GET] failed', err);
    return Response.json({ items: [], error: (err as Error).message }, { status: 500, headers });
  }
}

export async function OPTIONS(request: Request) {
  return corsPreflight(request);
}
