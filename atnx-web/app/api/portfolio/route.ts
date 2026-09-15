import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
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
  imageUrl: string | null;
  direction: 'long' | 'short';
  sizeUsd: number;
  leverage: number;
  entryVi: number;
  currentVi: number;
  valueUsd: number;
  pnlUsd: number;
  pnlPercent: number;
  openedAt: string;
}

export interface PortfolioPoint {
  t: string;
  value: number;
}

export interface PortfolioResponse {
  handle: string | null;
  balanceUsd: number;
  realizedPnlUsd: number;
  totalTrades: number;
  unrealizedPnlUsd: number;
  // Cash + open positions marked to market.
  totalValueUsd: number;
  positions: PortfolioPosition[];
  // Portfolio value over the last HISTORY_DAYS, oldest first.
  history: PortfolioPoint[];
  changeUsd: number;
  changePercent: number;
}

const INITIAL_BALANCE = 10000;
const HISTORY_DAYS = 7;
const MAX_POINTS = 80;

// Linear VI-based PnL, same math as calculatePnL in DemoContext and the
// server-side close in actions/trading.ts.
function directional(row: PositionRow, vi: number) {
  const entry = row.entry_vi || 1;
  const ratio = vi / entry;
  return row.direction === 'long' ? ratio - 1 : 1 - ratio;
}

function pnlFor(row: PositionRow) {
  const current = row.market?.current_vi ?? row.entry_vi;
  const d = directional(row, current);
  return {
    pnlUsd: row.size_usd * d * row.leverage,
    pnlPercent: d * row.leverage * 100,
    currentVi: current,
  };
}

// Reconstruct portfolio value over the window from each open position's
// market VI history. Cash is held at its current level; a position not yet
// opened at time t is counted as the cash it was bought with, so the curve is
// continuous at the open. Closed trades inside the window are not replayed —
// this is the equity curve of what the user holds now, not a full ledger.
function buildHistory(
  balanceUsd: number,
  positions: PositionRow[],
  viRows: { market_id: string; vi: number; recorded_at: string }[],
  now: Date
): PortfolioPoint[] {
  const start = new Date(now.getTime() - HISTORY_DAYS * 86_400_000);
  if (positions.length === 0) {
    return [
      { t: start.toISOString(), value: balanceUsd },
      { t: now.toISOString(), value: balanceUsd },
    ];
  }

  const byMarket = new Map<string, { t: number; vi: number }[]>();
  for (const r of viRows) {
    const list = byMarket.get(r.market_id) ?? [];
    list.push({ t: new Date(r.recorded_at).getTime(), vi: r.vi });
    byMarket.set(r.market_id, list);
  }
  for (const list of byMarket.values()) list.sort((a, b) => a.t - b.t);

  const times = new Set<number>([start.getTime(), now.getTime()]);
  for (const r of viRows) times.add(new Date(r.recorded_at).getTime());
  for (const p of positions) times.add(new Date(p.opened_at).getTime());
  let grid = [...times].filter((t) => t >= start.getTime()).sort((a, b) => a - b);

  // Keep the payload small: thin evenly but always keep the endpoints.
  if (grid.length > MAX_POINTS) {
    const step = (grid.length - 1) / (MAX_POINTS - 1);
    grid = Array.from({ length: MAX_POINTS }, (_, i) => grid[Math.round(i * step)]);
  }

  const viAt = (p: PositionRow, t: number) => {
    const list = byMarket.get(p.market_id);
    let vi = p.entry_vi;
    if (list) {
      for (const pt of list) {
        if (pt.t <= t) vi = pt.vi;
        else break;
      }
    }
    return vi;
  };

  return grid.map((t) => {
    let value = balanceUsd;
    for (const p of positions) {
      const openedAt = new Date(p.opened_at).getTime();
      if (t < openedAt) {
        value += p.size_usd;
      } else {
        value += p.size_usd * (1 + directional(p, viAt(p, t)) * p.leverage);
      }
    }
    return { t: new Date(t).toISOString(), value: Math.round(value * 100) / 100 };
  });
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

    const openPositions = pos ?? [];
    const marketIds = [...new Set(openPositions.map((p) => p.market_id))];
    const now = new Date();
    const since = new Date(now.getTime() - HISTORY_DAYS * 86_400_000).toISOString();

    // Thumbnails and VI history are shared market data (no user scoping), so
    // read them via the admin client like the rest of the market views.
    const admin = createAdminClient();
    const [{ data: imgRows }, { data: viRows }] = marketIds.length
      ? await Promise.all([
          admin
            .from('captures')
            .select('market_id, image_url, created_at')
            .in('market_id', marketIds)
            .is('deleted_at', null)
            .not('image_url', 'is', null)
            .order('created_at', { ascending: false }),
          admin
            .from('vi_history')
            .select('market_id, vi, recorded_at')
            .in('market_id', marketIds)
            .gte('recorded_at', since)
            .order('recorded_at', { ascending: true }),
        ])
      : [{ data: [] }, { data: [] }];

    // Newest capture per market is the first row we see for it.
    const imageByMarket = new Map<string, string>();
    for (const row of imgRows ?? []) {
      if (row.market_id && row.image_url && !imageByMarket.has(row.market_id)) {
        imageByMarket.set(row.market_id, row.image_url);
      }
    }

    const positions: PortfolioPosition[] = openPositions.map((row) => {
      const { pnlUsd, pnlPercent, currentVi } = pnlFor(row);
      return {
        id: row.id,
        marketId: row.market_id,
        name: row.market?.entity_name ?? 'Unknown',
        category: row.market?.entity_type ?? 'other',
        imageUrl: imageByMarket.get(row.market_id) ?? null,
        direction: row.direction,
        sizeUsd: row.size_usd,
        leverage: row.leverage,
        entryVi: Math.round(row.entry_vi),
        currentVi: Math.round(currentVi),
        valueUsd: row.size_usd + pnlUsd,
        pnlUsd,
        pnlPercent,
        openedAt: row.opened_at,
      };
    });

    const balanceUsd = bal?.balance_usd ?? INITIAL_BALANCE;
    const unrealizedPnlUsd = positions.reduce((sum, p) => sum + p.pnlUsd, 0);
    const totalValueUsd =
      balanceUsd + positions.reduce((sum, p) => sum + p.valueUsd, 0);

    const history = buildHistory(
      balanceUsd,
      openPositions,
      (viRows ?? []) as { market_id: string; vi: number; recorded_at: string }[],
      now
    );
    const first = history[0]?.value ?? totalValueUsd;
    const changeUsd = totalValueUsd - first;

    const body: PortfolioResponse = {
      handle: profile?.handle ?? null,
      balanceUsd,
      realizedPnlUsd: bal?.total_pnl_realized ?? 0,
      totalTrades: bal?.total_trades ?? 0,
      unrealizedPnlUsd,
      totalValueUsd,
      positions,
      history,
      changeUsd,
      changePercent: first > 0 ? (changeUsd / first) * 100 : 0,
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
