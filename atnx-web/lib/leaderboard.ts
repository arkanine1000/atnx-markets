import { createAdminClient } from './supabase/admin';

// Everyone starts the simulation with this much USDC (sim_balances default).
export const STARTING_BALANCE = 10000;

export interface LeaderboardRow {
  rank: number;
  userId: string;
  handle: string;
  // Cash plus open positions marked to each market's live VI.
  equity: number;
  // Equity against the starting balance, in percent.
  returnPct: number;
  realizedPnl: number;
  unrealizedPnl: number;
  openPositions: number;
  totalTrades: number;
}

type BalanceRow = {
  user_id: string;
  balance_usd: number;
  total_pnl_realized: number;
  total_trades: number;
};

type OpenPositionRow = {
  user_id: string;
  direction: 'long' | 'short';
  size_usd: number;
  entry_vi: number;
  leverage: number;
  market: { current_vi: number } | null;
};

// Same linear VI PnL as the portfolio page, the portfolio API and the
// server-side close: size × (vi/entry − 1) × leverage, sign flipped for a
// short.
function positionValue(p: OpenPositionRow): { value: number; pnl: number } {
  const entry = p.entry_vi || 1;
  const vi = p.market?.current_vi ?? p.entry_vi;
  const ratio = vi / entry;
  const directional = p.direction === 'long' ? ratio - 1 : 1 - ratio;
  const pnl = p.size_usd * directional * p.leverage;
  return { value: p.size_usd + pnl, pnl };
}

// Every account that has traded (a closed trade on record or a position
// open now), ranked by equity. Accounts that never traded all sit at the
// starting balance and would only pad the list. Three reads, no joins on
// the user side: balances, open positions with their market's VI, and
// handles; combined here. Reads use the admin client because sim_balances
// is per-user under RLS.
export async function getLeaderboard(): Promise<LeaderboardRow[]> {
  const admin = createAdminClient();
  const [balances, positions, profiles] = await Promise.all([
    admin
      .from('sim_balances')
      .select('user_id, balance_usd, total_pnl_realized, total_trades')
      .returns<BalanceRow[]>(),
    admin
      .from('positions')
      .select('user_id, direction, size_usd, entry_vi, leverage, market:markets(current_vi)')
      .eq('status', 'open')
      .returns<OpenPositionRow[]>(),
    admin.from('user_profiles').select('id, handle'),
  ]);
  if (balances.error) throw balances.error;
  if (positions.error) throw positions.error;
  if (profiles.error) throw profiles.error;

  const handles = new Map<string, string>();
  for (const p of profiles.data ?? []) handles.set(p.id, p.handle);

  const open = new Map<string, { value: number; pnl: number; count: number }>();
  for (const p of positions.data ?? []) {
    const { value, pnl } = positionValue(p);
    const acc = open.get(p.user_id) ?? { value: 0, pnl: 0, count: 0 };
    acc.value += value;
    acc.pnl += pnl;
    acc.count += 1;
    open.set(p.user_id, acc);
  }

  const rows: Omit<LeaderboardRow, 'rank'>[] = [];
  for (const b of balances.data ?? []) {
    const o = open.get(b.user_id);
    const totalTrades = Number(b.total_trades ?? 0);
    if (totalTrades === 0 && !o) continue;
    const equity = Number(b.balance_usd ?? STARTING_BALANCE) + (o?.value ?? 0);
    rows.push({
      userId: b.user_id,
      handle: handles.get(b.user_id) ?? 'anonymous',
      equity,
      returnPct: ((equity - STARTING_BALANCE) / STARTING_BALANCE) * 100,
      realizedPnl: Number(b.total_pnl_realized ?? 0),
      unrealizedPnl: o?.pnl ?? 0,
      openPositions: o?.count ?? 0,
      totalTrades,
    });
  }

  rows.sort(
    (a, b) =>
      b.equity - a.equity || b.totalTrades - a.totalTrades || a.handle.localeCompare(b.handle)
  );
  return rows.map((r, i) => ({ ...r, rank: i + 1 }));
}
