import { createAdminClient } from '@/lib/supabase/admin';
import type { BmMarketRow, BmMarketState, BmSide } from '@/lib/supabase/database-bm';

// The registry of bounded VI markets: which atnx market has which on-chain
// market, with what bounds, in which state. Rows live in the `bm` schema
// (supabase/bm/001_schema.sql) and are written only through the service
// role, from the open-market action and the keeper. Positions are not
// here; they are balances in the contract.

export type { BmMarketRow, BmMarketState, BmSide };

const LIVE_STATES: BmMarketState[] = ['pending', 'open', 'resolving'];

function bm() {
  return createAdminClient().schema('bm');
}

// Every bounded market on an atnx market, newest first (one live row per
// chain at most, plus the resolved history).
export async function getBoundedMarkets(atnxMarketId: string): Promise<BmMarketRow[]> {
  const { data, error } = await bm()
    .from('markets')
    .select('*')
    .eq('atnx_market_id', atnxMarketId)
    .order('created_at', { ascending: false });
  if (error) throw error;
  return (data ?? []) as BmMarketRow[];
}

export async function getBoundedMarket(id: string): Promise<BmMarketRow | null> {
  const { data, error } = await bm().from('markets').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as BmMarketRow | null) ?? null;
}

export async function listByState(states: BmMarketState[], limit = 500): Promise<BmMarketRow[]> {
  const { data, error } = await bm()
    .from('markets')
    .select('*')
    .in('state', states)
    .order('created_at', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as BmMarketRow[];
}

// Live rows (pending, open, resolving) across every chain, for the market
// list badges and the portfolio.
export async function listLive(): Promise<BmMarketRow[]> {
  return listByState(LIVE_STATES);
}

export async function listAll(limit = 200): Promise<BmMarketRow[]> {
  const { data, error } = await bm()
    .from('markets')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as BmMarketRow[];
}

export interface ClaimInput {
  atnxMarketId: string;
  chain: string;
  contractAddress: string;
  startVi: number;
  lower: number;
  upper: number;
  seedUsdg: number;
  initialUpBps?: number;
  openedBy?: string | null;
  openedByWallet?: string | null;
  rolledFrom?: string | null;
  roll?: number;
  // The latest vi_history.id at opening: prints before it never count.
  keeperCursor: number;
}

// Reserves the one live slot for (atnx market, chain) by inserting a
// `pending` row. The partial unique index makes a second claim fail with
// 23505, which comes back as null: someone else is opening it.
export async function claimPending(input: ClaimInput): Promise<BmMarketRow | null> {
  const { data, error } = await bm()
    .from('markets')
    .insert({
      atnx_market_id: input.atnxMarketId,
      chain: input.chain,
      contract_address: input.contractAddress,
      start_vi: input.startVi,
      lower_bound: input.lower,
      upper_bound: input.upper,
      seed_usdg: input.seedUsdg,
      initial_up_bps: input.initialUpBps ?? 5000,
      opened_by: input.openedBy ?? null,
      opened_by_wallet: input.openedByWallet ?? null,
      rolled_from: input.rolledFrom ?? null,
      roll: input.roll ?? 0,
      keeper_cursor: input.keeperCursor,
      state: 'pending',
    })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') return null;
    throw error;
  }
  return data as BmMarketRow;
}

export async function update(id: string, patch: Partial<BmMarketRow>): Promise<void> {
  const { error } = await bm()
    .from('markets')
    .update({ ...patch, updated_at: new Date().toISOString() })
    .eq('id', id);
  if (error) throw error;
}

export async function setCreateTx(id: string, tx: string): Promise<void> {
  return update(id, { create_tx: tx });
}

export async function markOpen(
  id: string,
  p: { onchainMarketId: string; createdBlock: number; createTx: string }
): Promise<void> {
  return update(id, {
    state: 'open',
    onchain_market_id: p.onchainMarketId,
    created_block: p.createdBlock,
    create_tx: p.createTx,
    error: null,
  });
}

export async function markFailed(id: string, reason: string): Promise<void> {
  return update(id, { state: 'failed', error: reason.slice(0, 500) });
}

export async function markResolving(id: string, tx: string): Promise<void> {
  return update(id, { state: 'resolving', resolve_tx: tx });
}

export async function markResolved(
  id: string,
  p: { side: BmSide; vi: number; tx: string | null }
): Promise<void> {
  return update(id, {
    state: 'resolved',
    resolved_side: p.side,
    resolved_vi: p.vi,
    resolved_at: new Date().toISOString(),
    resolve_tx: p.tx,
    streak_side: null,
    streak_count: 0,
  });
}

// Advances the keeper's cursor and streak only if nobody else moved it
// since we read it, so two overlapping keeper runs cannot double-count.
export async function advanceCursor(
  id: string,
  expectedCursor: number,
  next: { cursor: number; streakSide: BmSide | null; streakCount: number }
): Promise<boolean> {
  const { data, error } = await bm()
    .from('markets')
    .update({
      keeper_cursor: next.cursor,
      streak_side: next.streakSide,
      streak_count: next.streakCount,
      updated_at: new Date().toISOString(),
    })
    .eq('id', id)
    .eq('keeper_cursor', expectedCursor)
    .select('id');
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

export async function logKeeper(entry: {
  runId: string;
  marketId?: string | null;
  action: string;
  detail?: Record<string, unknown> | null;
  error?: string | null;
  txHash?: string | null;
}): Promise<void> {
  const { error } = await bm().from('keeper_log').insert({
    run_id: entry.runId,
    bm_market_id: entry.marketId ?? null,
    action: entry.action,
    detail: (entry.detail ?? null) as never,
    error: entry.error ? entry.error.slice(0, 1000) : null,
    tx_hash: entry.txHash ?? null,
  });
  if (error) console.error('[bm] keeper_log insert failed', error);
}

export async function recentKeeperLog(limit = 50) {
  const { data, error } = await bm()
    .from('keeper_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return data ?? [];
}
