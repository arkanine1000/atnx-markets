import { createClient } from '@/lib/supabase/server';
import { corsHeaders, corsPreflight } from '@/lib/cors';

// Read-only portfolio snapshot for the Chrome extension's side panel.
// Auth comes from the Supabase cookie (attached cross-origin via
// `credentials: 'include'`), so a signed-out caller gets 401 and the panel
// shows a sign-in prompt instead. Mirrors what DemoContext loads client-side.

type PositionRow = {
  id: string;
  market_id: string;
  direction: 'long' | 'short';
  size_usd: number;
  entry_vi: number;
  leverage: number;
  opened_at: string;
  market: {
    id: string;
    entity_name: string;
    entity_type: string | null;
    current_vi: number;
  } | null;
};

export interface PortfolioPosition {
  id: string;
  marketId: string;
  name: string;
  category: string;
  direction: 'long' | 'short';
  sizeUsd: number;
  leverage: number;
  entryVi: number;
  currentVi: number;
  pnlUsd: number;
  pnlPercent: number;
  openedAt: string;
}

export interface PortfolioResponse {
  handle: string | null;
  balanceUsd: number;
  realizedPnlUsd: number;
  totalTrades: number;
  unrealizedPnlUsd: number;
  positions: PortfolioPosition[];
}

const INITIAL_BALANCE = 10000;

// Linear VI-based PnL, same math as calculatePnL in DemoContext and the
// server-side close in actions/trading.ts.
function pnlFor(row: PositionRow) {
  const entry = row.entry_vi || 1;
  const current = row.market?.current_vi ?? row.entry_vi;
  const ratio = current / entry;
  const directional = row.direction === 'long' ? ratio - 1 : 1 - ratio;
  return {
    pnlUsd: row.size_usd * directional * row.leverage,
    pnlPercent: directional * row.leverage * 100,
    currentVi: current,
  };
}

export async function GET(request: Request) {
  const headers = corsHeaders(request);

  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();

  if (!user) {
    return Response.json({ error: 'Not signed in' }, { status: 401, headers });
  }

  try {
    const [{ data: profile }, { data: bal }, { data: pos, error: posErr }] =
      await Promise.all([
        supabase
          .from('user_profiles')
          .select('handle')
          .eq('id', user.id)
          .maybeSingle(),
        supabase
          .from('sim_balances')
          .select('balance_usd, total_pnl_realized, total_trades')
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase
          .from('positions')
          .select(
            'id, market_id, direction, size_usd, entry_vi, leverage, opened_at, market:markets(id, entity_name, entity_type, current_vi)'
          )
          .eq('user_id', user.id)
          .eq('status', 'open')
          .order('opened_at', { ascending: false })
          .returns<PositionRow[]>(),
      ]);
    if (posErr) throw posErr;

    const positions: PortfolioPosition[] = (pos ?? []).map((row) => {
      const { pnlUsd, pnlPercent, currentVi } = pnlFor(row);
      return {
        id: row.id,
        marketId: row.market_id,
        name: row.market?.entity_name ?? 'Unknown',
        category: row.market?.entity_type ?? 'other',
        direction: row.direction,
        sizeUsd: row.size_usd,
        leverage: row.leverage,
        entryVi: Math.round(row.entry_vi),
        currentVi: Math.round(currentVi),
        pnlUsd,
        pnlPercent,
        openedAt: row.opened_at,
      };
    });

    const body: PortfolioResponse = {
      handle: profile?.handle ?? null,
      balanceUsd: bal?.balance_usd ?? INITIAL_BALANCE,
      realizedPnlUsd: bal?.total_pnl_realized ?? 0,
      totalTrades: bal?.total_trades ?? 0,
      unrealizedPnlUsd: positions.reduce((sum, p) => sum + p.pnlUsd, 0),
      positions,
    };

    return Response.json(body, { headers });
  } catch (err) {
    console.error('[portfolio GET] failed', err);
    return Response.json(
      { error: (err as Error).message },
      { status: 500, headers }
    );
  }
}

export async function OPTIONS(request: Request) {
  return corsPreflight(request);
}
