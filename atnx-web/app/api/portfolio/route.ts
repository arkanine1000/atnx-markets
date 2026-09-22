import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { corsHeaders, corsPreflight } from '@/lib/cors';

// Read-only portfolio snapshot for the Chrome extension's side panel.
// Auth comes from the Supabase cookie (attached cross-origin via
// `credentials: 'include'`), so a signed-out caller gets 401 and the panel
// shows a sign-in prompt instead. Mirrors what DemoContext loads client-side.
//
// `?range=1d|1w|1m|all` picks the history window (default 1w). The delta
// fields describe the same window, so the tile's number and its chart agree.

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

export type PortfolioRange = '1d' | '1w' | '1m' | 'all';

export interface PortfolioResponse {
  handle: string | null;
  balanceUsd: number;
  realizedPnlUsd: number;
  totalTrades: number;
  unrealizedPnlUsd: number;
  // Cash + open positions marked to market.
  totalValueUsd: number;
  positions: PortfolioPosition[];
  // Window the history and delta fields cover.
  range: PortfolioRange;
  // Portfolio value over the window, oldest first. The last point is `now`
  // and equals totalValueUsd.
  history: PortfolioPoint[];
  changeUsd: number;
  changePercent: number;
}

const INITIAL_BALANCE = 10000;
const DAY_MS = 86_400_000;
const MAX_POINTS = 160;

// Bucket widths are chosen so a full window is ~100–180 medians per market:
// dense enough for a smooth line, sparse enough that one stray 5-minute
// sample cannot draw a spike.
const WINDOWS: Record<Exclude<PortfolioRange, 'all'>, { ms: number; bucketSeconds: number }> = {
  '1d': { ms: DAY_MS, bucketSeconds: 15 * 60 },
  '1w': { ms: 7 * DAY_MS, bucketSeconds: 60 * 60 },
  '1m': { ms: 30 * DAY_MS, bucketSeconds: 4 * 60 * 60 },
};

function parseRange(value: string | null): PortfolioRange {
  return value === '1d' || value === '1m' || value === 'all' ? value : '1w';
}

type ViPoint = { t: number; vi: number };
type ViSeries = Map<string, ViPoint[]>;

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

// Median-per-bucket reduction, the same shape vi_history_series() returns.
// Used on the raw-row fallback so both paths draw the same line.
function bucketMedians(
  rows: { market_id: string; vi: number; recorded_at: string }[],
  bucketMs: number
): ViSeries {
  const buckets = new Map<string, Map<number, number[]>>();
  for (const r of rows) {
    const t = Math.floor(new Date(r.recorded_at).getTime() / bucketMs) * bucketMs;
    const perMarket = buckets.get(r.market_id) ?? new Map<number, number[]>();
    const list = perMarket.get(t) ?? [];
    list.push(Number(r.vi));
    perMarket.set(t, list);
    buckets.set(r.market_id, perMarket);
  }
  const series: ViSeries = new Map();
  for (const [marketId, perMarket] of buckets) {
    const points = [...perMarket.entries()]
      .map(([t, values]) => {
        values.sort((a, b) => a - b);
        const mid = values.length >> 1;
        const vi = values.length % 2 ? values[mid] : (values[mid - 1] + values[mid]) / 2;
        return { t, vi };
      })
      .sort((a, b) => a.t - b.t);
    series.set(marketId, points);
  }
  return series;
}

async function loadViSeries(
  admin: ReturnType<typeof createAdminClient>,
  marketIds: string[],
  since: Date,
  bucketSeconds: number
): Promise<ViSeries> {
  const { data, error } = await admin.rpc('vi_history_series', {
    market_ids: marketIds,
    since: since.toISOString(),
    bucket_seconds: bucketSeconds,
  });
  if (!error) {
    const series: ViSeries = new Map();
    for (const row of data ?? []) {
      series.set(
        row.market_id,
        (row.points ?? []).map(([t, vi]) => ({ t: Number(t), vi: Number(vi) }))
      );
    }
    return series;
  }

  // Migration 005 not applied yet: read the newest raw rows per market
  // (PostgREST caps a select at 1,000 rows) and bucket them here.
  console.warn('[portfolio GET] vi_history_series unavailable, using raw rows:', error.message);
  const perMarket = await Promise.all(
    marketIds.map((id) =>
      admin
        .from('vi_history')
        .select('market_id, vi, recorded_at')
        .eq('market_id', id)
        .gte('recorded_at', since.toISOString())
        .order('recorded_at', { ascending: false })
        .limit(1000)
    )
  );
  const rows = perMarket.flatMap(({ data: r }) => r ?? []);
  return bucketMedians(rows, bucketSeconds * 1000);
}

// Reconstruct portfolio value over the window from each open position's
// market VI history. Cash is held at its current level; a position not yet
// opened at time t is counted as the cash it was bought with, so the curve is
// continuous at the open. The final point is `now` and is marked with each
// market's live current_vi, so the curve ends exactly on totalValueUsd.
// Closed trades inside the window are not replayed — this is the equity
// curve of what the user holds now, not a full ledger.
function buildHistory(
  balanceUsd: number,
  positions: PositionRow[],
  series: ViSeries,
  start: Date,
  now: Date
): PortfolioPoint[] {
  const startMs = start.getTime();
  const nowMs = now.getTime();
  if (positions.length === 0) {
    return [
      { t: start.toISOString(), value: balanceUsd },
      { t: now.toISOString(), value: balanceUsd },
    ];
  }

  const times = new Set<number>([startMs, nowMs]);
  for (const list of series.values()) {
    for (const p of list) times.add(p.t);
  }
  for (const p of positions) times.add(new Date(p.opened_at).getTime());
  let grid = [...times].filter((t) => t >= startMs && t <= nowMs).sort((a, b) => a - b);

  // Keep the payload small: thin evenly but always keep the endpoints.
  if (grid.length > MAX_POINTS) {
    const step = (grid.length - 1) / (MAX_POINTS - 1);
    grid = Array.from({ length: MAX_POINTS }, (_, i) => grid[Math.round(i * step)]);
  }

  // Step function: the last bucket at or before t. Before the first bucket
  // the position is worth what it was bought at; at `now` it is worth what
  // the market says right now.
  const viAt = (p: PositionRow, t: number) => {
    if (t >= nowMs) return p.market?.current_vi ?? p.entry_vi;
    const list = series.get(p.market_id);
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
  const range = parseRange(new URL(request.url).searchParams.get('range'));

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

    // "All" runs from the account's first day (or its oldest open position,
    // whichever is earlier), never less than a day so the chart has width.
    let start: Date;
    let bucketSeconds: number;
    if (range === 'all') {
      const candidates = [new Date(user.created_at).getTime(), now.getTime() - DAY_MS];
      for (const p of openPositions) candidates.push(new Date(p.opened_at).getTime());
      start = new Date(Math.min(...candidates.filter((t) => Number.isFinite(t))));
      // ~150 buckets across the span, in whole quarter-hours, at least 15 min.
      const span = now.getTime() - start.getTime();
      bucketSeconds = Math.max(15 * 60, Math.ceil(span / 150 / 900_000) * 900);
    } else {
      start = new Date(now.getTime() - WINDOWS[range].ms);
      bucketSeconds = WINDOWS[range].bucketSeconds;
    }

    // Thumbnails and VI history are shared market data (no user scoping), so
    // read them via the admin client like the rest of the market views.
    const admin = createAdminClient();
    const [{ data: imgRows }, series] = marketIds.length
      ? await Promise.all([
          admin
            .from('captures')
            .select('market_id, image_url, created_at')
            .in('market_id', marketIds)
            .is('deleted_at', null)
            .not('image_url', 'is', null)
            .order('created_at', { ascending: false }),
          loadViSeries(admin, marketIds, start, bucketSeconds),
        ])
      : [{ data: [] }, new Map() as ViSeries];

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

    const history = buildHistory(balanceUsd, openPositions, series, start, now);
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
      range,
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
