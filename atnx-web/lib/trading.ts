import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database } from '@/lib/supabase/database';

// The two trades, as thin wrappers over the open_position() and
// close_position() database functions (supabase/006, fees and liquidation
// in 009). The accounting lives there, in one transaction with the balance
// row locked, because a check-then-write from here let two concurrent opens
// overdraw and a double-click close credit twice. The functions also
// validate size, leverage and direction, charge the 1% fee and floor the
// loss at the size, and RLS no longer lets a user write positions or
// balances directly, so this is the only way in.
//
// Called from the server actions the site's own pages use
// (app/app/actions/trading.ts) and from the cookie-authenticated routes
// under /api/positions that the extension's side panel calls, so both
// paths apply the same checks and report the same errors.

export interface OpenPositionInput {
  marketId: string;
  direction: 'long' | 'short';
  sizeUsd: number;
  leverage?: number;
}

export interface TradingResult {
  success: boolean;
  error?: string;
}

export interface OpenPositionResult extends TradingResult {
  positionId?: string;
}

export interface ClosePositionResult extends TradingResult {
  realizedPnl?: number;
  exitVi?: number;
  // The loss had reached the full size, so the close paid nothing back.
  liquidated?: boolean;
}

// Postgres wraps a raise exception as "P0001"; its message is ours and
// safe to show. Anything else is reported generically.
function userMessage(err: { code?: string; message: string }, fallback: string): string {
  return err.code === 'P0001' ? err.message : fallback;
}

export async function openPositionFor(
  supabase: SupabaseClient<Database>,
  input: OpenPositionInput
): Promise<OpenPositionResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'Not signed in' };

  if (typeof input.marketId !== 'string' || !input.marketId) {
    return { success: false, error: 'Invalid market' };
  }
  const sizeUsd = Number(input.sizeUsd);
  const leverage = Number(input.leverage ?? 1);
  if (!Number.isFinite(sizeUsd) || sizeUsd <= 0) return { success: false, error: 'Invalid size' };
  if (!Number.isFinite(leverage) || leverage < 1 || leverage > 10) {
    return { success: false, error: 'Invalid leverage' };
  }
  if (input.direction !== 'long' && input.direction !== 'short') {
    return { success: false, error: 'Invalid direction' };
  }

  const { data: positionId, error } = await supabase.rpc('open_position', {
    p_market_id: input.marketId,
    p_direction: input.direction,
    p_size_usd: sizeUsd,
    p_leverage: leverage,
  });
  if (error) {
    console.error('[openPosition] failed', error);
    return { success: false, error: userMessage(error, 'Could not open position') };
  }

  return { success: true, positionId: positionId as string };
}

export async function closePositionFor(
  supabase: SupabaseClient<Database>,
  positionId: string
): Promise<ClosePositionResult> {
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'Not signed in' };
  if (typeof positionId !== 'string' || !positionId) {
    return { success: false, error: 'Invalid position' };
  }

  const { data, error } = await supabase.rpc('close_position', { p_position_id: positionId });
  if (error) {
    console.error('[closePosition] failed', error);
    return { success: false, error: userMessage(error, 'Could not close position') };
  }

  return {
    success: true,
    realizedPnl: Number(data?.realized_pnl ?? 0),
    exitVi: Number(data?.exit_vi ?? 0),
    liquidated: Boolean(data?.liquidated),
  };
}
