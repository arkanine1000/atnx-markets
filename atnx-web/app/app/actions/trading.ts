'use server';

import { createClient } from '@/lib/supabase/server';
import { revalidatePath } from 'next/cache';

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
}

export async function openPosition(
  input: OpenPositionInput
): Promise<OpenPositionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'Not signed in' };

  if (!(input.sizeUsd > 0)) {
    return { success: false, error: 'Invalid size' };
  }

  const { data: market, error: marketErr } = await supabase
    .from('markets')
    .select('id, current_vi')
    .eq('id', input.marketId)
    .is('deleted_at', null)
    .maybeSingle();
  if (marketErr) return { success: false, error: marketErr.message };
  if (!market) return { success: false, error: 'Market not found' };

  const { data: balance, error: balErr } = await supabase
    .from('sim_balances')
    .select('balance_usd, total_trades')
    .eq('user_id', user.id)
    .maybeSingle();
  if (balErr) return { success: false, error: balErr.message };
  if (!balance) return { success: false, error: 'No balance row' };
  if (balance.balance_usd < input.sizeUsd) {
    return { success: false, error: 'Insufficient balance' };
  }

  // Weekend-MVP pricing: entry_price = current_vi. Full PMM comes later.
  const entryPrice = market.current_vi;

  const { data: position, error: insertErr } = await supabase
    .from('positions')
    .insert({
      user_id: user.id,
      market_id: input.marketId,
      direction: input.direction,
      size_usd: input.sizeUsd,
      entry_vi: market.current_vi,
      entry_price: entryPrice,
      leverage: input.leverage ?? 1,
      network: 'simulated',
      status: 'open',
    })
    .select('id')
    .single();
  if (insertErr) return { success: false, error: insertErr.message };

  const { error: updateErr } = await supabase
    .from('sim_balances')
    .update({
      balance_usd: balance.balance_usd - input.sizeUsd,
      total_trades: balance.total_trades + 1,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', user.id);
  if (updateErr) return { success: false, error: updateErr.message };

  revalidatePath('/app');
  revalidatePath('/app/portfolio');
  return { success: true, positionId: position.id };
}

export async function closePosition(
  positionId: string
): Promise<ClosePositionResult> {
  const supabase = await createClient();
  const {
    data: { user },
  } = await supabase.auth.getUser();
  if (!user) return { success: false, error: 'Not signed in' };

  const { data: position, error: posErr } = await supabase
    .from('positions')
    .select(
      'id, user_id, direction, size_usd, entry_vi, entry_price, leverage, status, market_id, market:markets(current_vi)'
    )
    .eq('id', positionId)
    .eq('user_id', user.id)
    .eq('status', 'open')
    .maybeSingle<
      {
        id: string;
        user_id: string;
        direction: 'long' | 'short';
        size_usd: number;
        entry_vi: number;
        entry_price: number;
        leverage: number;
        status: 'open' | 'closed';
        market_id: string;
        market: { current_vi: number } | null;
      }
    >();
  if (posErr) return { success: false, error: posErr.message };
  if (!position) return { success: false, error: 'Position not found' };

  const exitVi = position.market?.current_vi ?? position.entry_vi;
  const exitPrice = exitVi;

  // Simple linear PnL for weekend MVP.
  const priceRatio = position.entry_price === 0 ? 1 : exitPrice / position.entry_price;
  const directionMultiplier =
    position.direction === 'long' ? priceRatio - 1 : 1 - priceRatio;
  const realizedPnl = position.size_usd * directionMultiplier * position.leverage;

  const { error: closeErr } = await supabase
    .from('positions')
    .update({
      status: 'closed',
      closed_at: new Date().toISOString(),
      exit_vi: exitVi,
      exit_price: exitPrice,
      realized_pnl: realizedPnl,
    })
    .eq('id', positionId);
  if (closeErr) return { success: false, error: closeErr.message };

  const { data: bal, error: balErr } = await supabase
    .from('sim_balances')
    .select('balance_usd, total_pnl_realized')
    .eq('user_id', user.id)
    .maybeSingle();
  if (balErr) return { success: false, error: balErr.message };
  if (!bal) return { success: false, error: 'No balance row' };

  const { error: credErr } = await supabase
    .from('sim_balances')
    .update({
      balance_usd: bal.balance_usd + position.size_usd + realizedPnl,
      total_pnl_realized: bal.total_pnl_realized + realizedPnl,
      updated_at: new Date().toISOString(),
    })
    .eq('user_id', user.id);
  if (credErr) return { success: false, error: credErr.message };

  revalidatePath('/app');
  revalidatePath('/app/portfolio');
  return { success: true, realizedPnl, exitVi };
}
