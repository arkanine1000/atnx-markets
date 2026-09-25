import { createClient } from '@/lib/supabase/server';
import { createAdminClient } from '@/lib/supabase/admin';
import { RPC_MISSING } from '@/lib/store';
import { positionPnl } from '@/lib/pnl';
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
  fee_usd: number | null;
  market: {
    id: string;
    entity_name: string;
    entity_type: string | null;
    current_vi: number;
    thumbnail_url: string | null;
    thumbnail_source: string | null;
  } | null;
};

export interface PortfolioPosition {
  id: string;
  marketId: string;
  name: string;
  category: string;
  // The market's curated image when it has one, else its newest capture.
  imageUrl: string | null;
  // markets.thumbnail_source when imageUrl is the curated image (a
  // 'wikidata:logo' is drawn contained on a light tile); null otherwise.
  imageSource: string | null;
  direction: 'long' | 'short';
  sizeUsd: number;
  leverage: number;
  entryVi: number;
  currentVi: number;
  valueUsd: number;
  pnlUsd: number;
  pnlPercent: number;
  // The mark has reached −100%; the next VI write closes it for nothing.
  liquidated: boolean;
  openedAt: string;
}

export interface PortfolioPoint {
  t: string;
  value: number;
}

export type PortfolioRange = '1d' | '1w' | '1m' | 'all';

export interface PortfolioResponse {
  // The account id: the seed for the avatar, so the extension draws the
  // same face as the site.
  userId: string;
  handle: string | null;
  balanceUsd: number;
  realizedPnlUsd: number;
  totalTrades: number;
  // Creator share of trading fees on markets this account created (already
  // in balanceUsd) and fees paid on this account's own opens.
  feesEarnedUsd: number;
  feesPaidUsd: number;
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

// Linear VI-based PnL floored at −size, same math as calculatePnL in
// DemoContext and the server-side close (lib/pnl.ts).
function pnlAt(row: PositionRow, vi: number) {
  return positionPnl({
    sizeUsd: row.size_usd,
    entryVi: row.entry_vi,
    currentVi: vi,
    direction: row.direction,
    leverage: row.leverage,
  });
}

function pnlFor(row: PositionRow) {
  const current = row.market?.current_vi ?? row.entry_vi;
  return { ...pnlAt(row, current), currentVi: current };
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

  // A database error is an error: the panel keeps its last good chart
  // rather than drawing a wrong one, and nothing here asks again. (It used
  // to fall back to one query per market on any error, which multiplied
  // every failure under load.)
  if (error.code !== RPC_MISSING) throw new Error(`vi_history_series: ${error.message}`);

  // Migration 005 not applied yet: one query for the newest raw rows across
  // every open position's market (PostgREST caps a select at 1,000 rows),
  // bucketed here.
  console.warn('[portfolio GET] vi_history_series missing (apply supabase/005), using raw rows');
  const { data: rows, error: rowsErr } = await admin
    .from('vi_history')
    .select('market_id, vi, recorded_at')
    .in('market_id', marketIds)
    .gte('recorded_at', since.toISOString())
    .order('recorded_at', { ascending: false })
    .limit(1000);
  if (rowsErr) throw new Error(`vi_history: ${rowsErr.message}`);
  return bucketMedians(rows ?? [], bucketSeconds * 1000);
}

// A position as the history replay needs it: open ones have no close yet.
type LedgerPosition = {
  market_id: string;
  direction: 'long' | 'short';
  size_usd: number;
  entry_vi: number;
  leverage: number;
  opened_at: string;
  fee_usd: number;
  closed_at: string | null;
  realized_pnl: number | null;
  // Live score, used for the final `now` point of a still-open position.
  current_vi: number | null;
};

// A change to cash at a moment in time.
type CashEvent = { t: number; delta: number };

// Reconstruct portfolio value over the window by replaying the ledger
// backwards from today's balance. Cash only moves through trading (open:
// −size −fee; close: +size +realized PnL; creator fee share: +share), so
// cash at time t is the current balance minus every movement after t. On
// top of that, each position that was open at t is marked at its market's
// VI at t. Closed trades therefore show up as the steps they were, and the
// curve starts where the account really stood. The final point is `now`
// and is marked with each market's live current_vi, so the curve ends
// exactly on totalValueUsd.
function buildHistory(
  balanceUsd: number,
  positions: LedgerPosition[],
  cashEvents: CashEvent[],
  series: ViSeries,
  start: Date,
  now: Date
): PortfolioPoint[] {
  const startMs = start.getTime();
  const nowMs = now.getTime();

  const legs = positions.map((p) => ({
    row: p,
    openMs: new Date(p.opened_at).getTime(),
    closeMs: p.closed_at ? new Date(p.closed_at).getTime() : Infinity,
  }));

  // Every cash movement, oldest first.
  const events: CashEvent[] = [...cashEvents];
  for (const l of legs) {
    events.push({ t: l.openMs, delta: -(l.row.size_usd + (l.row.fee_usd ?? 0)) });
    if (Number.isFinite(l.closeMs)) {
      events.push({ t: l.closeMs, delta: l.row.size_usd + (l.row.realized_pnl ?? 0) });
    }
  }
  events.sort((a, b) => a.t - b.t);

  const times = new Set<number>([startMs, nowMs]);
  for (const list of series.values()) {
    for (const p of list) times.add(p.t);
  }
  // Just before and at every movement, so a trade draws as a step rather
  // than a slope smeared across the neighbouring buckets.
  for (const e of events) {
    times.add(e.t - 1);
    times.add(e.t);
  }
  let grid = [...times].filter((t) => t >= startMs && t <= nowMs).sort((a, b) => a - b);

  // Keep the payload small: thin evenly but always keep the endpoints.
  if (grid.length > MAX_POINTS) {
    const step = (grid.length - 1) / (MAX_POINTS - 1);
    grid = Array.from({ length: MAX_POINTS }, (_, i) => grid[Math.round(i * step)]);
  }

  // Step function: the last bucket at or before t. Before the first bucket
  // the position is worth what it was bought at; at `now` it is worth what
  // the market says right now.
  const viAt = (p: LedgerPosition, t: number) => {
    if (t >= nowMs && !p.closed_at) return p.current_vi ?? p.entry_vi;
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

  // Walk the grid newest to oldest, peeling off movements as we pass them.
  const values = new Array<number>(grid.length);
  let cash = balanceUsd;
  let e = events.length - 1;
  for (let i = grid.length - 1; i >= 0; i--) {
    const t = grid[i];
    while (e >= 0 && events[e].t > t) {
      cash -= events[e].delta;
      e--;
    }
    let value = cash;
    for (const l of legs) {
      if (t < l.openMs || t >= l.closeMs) continue;
      const pnl = positionPnl({
        sizeUsd: l.row.size_usd,
        entryVi: l.row.entry_vi,
        currentVi: viAt(l.row, t),
        direction: l.row.direction,
        leverage: l.row.leverage,
      }).pnlUsd;
      value += l.row.size_usd + pnl;
    }
    values[i] = Math.round(value * 100) / 100;
  }
  return grid.map((t, i) => ({ t: new Date(t).toISOString(), value: values[i] }));
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
          .select('balance_usd, total_pnl_realized, total_trades, fees_earned_usd, fees_paid_usd')
          .eq('user_id', user.id)
          .maybeSingle(),
        supabase
          .from('positions')
          .select(
            'id, market_id, direction, size_usd, entry_vi, leverage, opened_at, fee_usd, market:markets(id, entity_name, entity_type, current_vi, thumbnail_url, thumbnail_source)'
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

    // The rest of the ledger the chart replays: trades closed inside the
    // window (their cash came back then, and they were marked until then)
    // and the creator share of fees paid to this account inside it.
    const [{ data: closedRows, error: closedErr }, { data: feeRows, error: feeErr }] =
      await Promise.all([
        supabase
          .from('positions')
          .select('market_id, direction, size_usd, entry_vi, leverage, opened_at, fee_usd, closed_at, realized_pnl')
          .eq('user_id', user.id)
          .eq('status', 'closed')
          .gte('closed_at', start.toISOString())
          .order('closed_at', { ascending: false })
          .limit(1000),
        supabase
          .from('fee_events')
          .select('creator_usd, created_at')
          .eq('creator_user_id', user.id)
          .gt('creator_usd', 0)
          .gte('created_at', start.toISOString())
          .order('created_at', { ascending: false })
          .limit(1000),
      ]);
    if (closedErr) throw closedErr;
    if (feeErr) throw feeErr;

    const ledger: LedgerPosition[] = [
      ...openPositions.map((p) => ({
        market_id: p.market_id,
        direction: p.direction,
        size_usd: Number(p.size_usd),
        entry_vi: Number(p.entry_vi),
        leverage: Number(p.leverage ?? 1),
        opened_at: p.opened_at,
        fee_usd: Number(p.fee_usd ?? 0),
        closed_at: null,
        realized_pnl: null,
        current_vi: p.market?.current_vi ?? null,
      })),
      ...(closedRows ?? [])
        .filter((p) => p.closed_at)
        .map((p) => ({
          market_id: p.market_id,
          direction: p.direction as 'long' | 'short',
          size_usd: Number(p.size_usd),
          entry_vi: Number(p.entry_vi),
          leverage: Number(p.leverage ?? 1),
          opened_at: p.opened_at ?? p.closed_at!,
          fee_usd: Number(p.fee_usd ?? 0),
          closed_at: p.closed_at,
          realized_pnl: p.realized_pnl === null ? 0 : Number(p.realized_pnl),
          current_vi: null,
        })),
    ];
    const cashEvents: CashEvent[] = (feeRows ?? []).map((f) => ({
      t: new Date(f.created_at).getTime(),
      delta: Number(f.creator_usd),
    }));
    const seriesIds = [...new Set(ledger.map((p) => p.market_id))];

    // Thumbnails and VI history are shared market data (no user scoping), so
    // read them via the admin client like the rest of the market views.
    const admin = createAdminClient();
    const [{ data: imgRows }, series] = seriesIds.length
      ? await Promise.all([
          admin
            .from('captures')
            .select('market_id, image_url, created_at')
            .in('market_id', marketIds)
            .is('deleted_at', null)
            .not('image_url', 'is', null)
            .order('created_at', { ascending: false }),
          loadViSeries(admin, seriesIds, start, bucketSeconds),
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
      const { pnlUsd, pnlPercent, liquidated, currentVi } = pnlFor(row);
      return {
        id: row.id,
        marketId: row.market_id,
        name: row.market?.entity_name ?? 'Unknown',
        category: row.market?.entity_type ?? 'other',
        imageUrl: row.market?.thumbnail_url ?? imageByMarket.get(row.market_id) ?? null,
        imageSource: row.market?.thumbnail_url ? (row.market.thumbnail_source ?? null) : null,
        direction: row.direction,
        sizeUsd: row.size_usd,
        leverage: row.leverage,
        entryVi: Math.round(row.entry_vi),
        currentVi: Math.round(currentVi),
        valueUsd: row.size_usd + pnlUsd,
        pnlUsd,
        pnlPercent,
        liquidated,
        openedAt: row.opened_at,
      };
    });

    const balanceUsd = bal?.balance_usd ?? INITIAL_BALANCE;
    const unrealizedPnlUsd = positions.reduce((sum, p) => sum + p.pnlUsd, 0);
    const totalValueUsd =
      balanceUsd + positions.reduce((sum, p) => sum + p.valueUsd, 0);

    const history = buildHistory(balanceUsd, ledger, cashEvents, series, start, now);
    const first = history[0]?.value ?? totalValueUsd;
    const changeUsd = totalValueUsd - first;

    const body: PortfolioResponse = {
      userId: user.id,
      handle: profile?.handle ?? null,
      balanceUsd,
      realizedPnlUsd: bal?.total_pnl_realized ?? 0,
      totalTrades: bal?.total_trades ?? 0,
      feesEarnedUsd: Number(bal?.fees_earned_usd ?? 0),
      feesPaidUsd: Number(bal?.fees_paid_usd ?? 0),
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
