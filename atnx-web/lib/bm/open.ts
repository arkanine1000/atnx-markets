import { createAdminClient } from '@/lib/supabase/admin';
import { bounds } from './bounds';
import { chainByKey, type BmChain } from './chains';
import {
  ensureSeed,
  getReceipt,
  keeperAccount,
  marketIdFromReceipt,
  refFor,
  requireDeployed,
  sendCreateMarket,
  usdgToUnits,
  waitReceipt,
} from './evm';
import * as registry from './registry';
import type { BmMarketRow } from '@/lib/supabase/database-bm';

// Opens a bounded market on an atnx market: reads the live VI, computes
// the bounds, reserves the one live slot per (market, chain) in the
// registry, seeds the pool on-chain from the keeper's mock USDG, and
// records the on-chain id. Used by the "Open UP/DOWN market" button
// (through the server action) and by the keeper's auto-roll.

export const SEED_USDG = Number(process.env.BM_SEED_USDG ?? 1000);
export const MAX_VI_AGE_MIN = Number(process.env.BM_MAX_VI_AGE_MIN ?? 30);
export const DEFAULT_UP_BPS = 5000;

export type OpenResult =
  | { ok: true; row: BmMarketRow }
  | { ok: false; error: string; code: 'not_found' | 'scoring' | 'no_vi' | 'stale_vi' | 'already_open' | 'chain' | 'tx' };

export interface OpenInput {
  atnxMarketId: string;
  chainKey: string;
  openedBy?: string | null;
  rolledFrom?: string | null;
  roll?: number;
  dry?: boolean;
}

interface ViSnapshot {
  vi: number;
  state: string;
  updatedAt: string | null;
}

export async function readLiveVi(atnxMarketId: string): Promise<ViSnapshot | null> {
  const { data, error } = await createAdminClient()
    .from('markets')
    .select('current_vi, vi_state, vi_last_updated')
    .eq('id', atnxMarketId)
    .is('deleted_at', null)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  return { vi: Number(data.current_vi ?? 0), state: String(data.vi_state ?? 'live'), updatedAt: data.vi_last_updated };
}

// The guard that keeps a stale VI (atnx.app's cron down) from opening a
// market with bounds around a number nobody is updating.
export function viIsFresh(updatedAt: string | null, now = Date.now()): boolean {
  if (!updatedAt) return false;
  return now - new Date(updatedAt).getTime() <= MAX_VI_AGE_MIN * 60_000;
}

export async function openBoundedMarket(input: OpenInput): Promise<OpenResult> {
  const chain = chainByKey(input.chainKey);
  if (!chain) return { ok: false, error: 'Unknown chain', code: 'chain' };
  try {
    requireDeployed(chain);
  } catch (err) {
    return { ok: false, error: (err as Error).message, code: 'chain' };
  }

  const snap = await readLiveVi(input.atnxMarketId);
  if (!snap) return { ok: false, error: 'Market not found', code: 'not_found' };
  if (snap.state === 'scoring') return { ok: false, error: 'Market is still being scored', code: 'scoring' };
  if (!(snap.vi > 0)) return { ok: false, error: 'Market has no score yet', code: 'no_vi' };
  if (!viIsFresh(snap.updatedAt)) {
    return { ok: false, error: `The VI has not been updated for over ${MAX_VI_AGE_MIN} minutes`, code: 'stale_vi' };
  }

  const b = bounds(snap.vi);
  const roll = input.roll ?? 0;
  const row = await registry.claimPending({
    atnxMarketId: input.atnxMarketId,
    chain: chain.key,
    contractAddress: chain.markets,
    startVi: snap.vi,
    lower: b.lower,
    upper: b.upper,
    seedUsdg: SEED_USDG,
    initialUpBps: DEFAULT_UP_BPS,
    openedBy: input.openedBy ?? null,
    rolledFrom: input.rolledFrom ?? null,
    roll,
  });
  if (!row) return { ok: false, error: 'A bounded market is already open on this chain', code: 'already_open' };
  if (input.dry) return { ok: true, row };

  try {
    const seed = usdgToUnits(SEED_USDG);
    await ensureSeed(chain, seed);
    const hash = await sendCreateMarket(chain, {
      ref: refFor(input.atnxMarketId, roll),
      creator: keeperAccount().address,
      startVi: snap.vi,
      lower: b.lower,
      upper: b.upper,
      seed,
      upBps: DEFAULT_UP_BPS,
    });
    await registry.setCreateTx(row.id, hash);
    const receipt = await waitReceipt(chain, hash);
    return finishCreate(chain, row.id, hash, receipt);
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    // If the tx was sent but the wait timed out, leave the row pending for
    // the keeper to reconcile; only an outright send failure is final.
    const sent = (await registry.getBoundedMarket(row.id))?.create_tx;
    if (!sent) await registry.markFailed(row.id, msg);
    console.error('[bm] open failed', msg);
    return { ok: false, error: sent ? 'Transaction sent; waiting for confirmation' : msg, code: 'tx' };
  }
}

export async function finishCreate(
  chain: BmChain,
  rowId: string,
  hash: `0x${string}`,
  receipt: NonNullable<Awaited<ReturnType<typeof getReceipt>>>
): Promise<OpenResult> {
  if (receipt.status !== 'success') {
    await registry.markFailed(rowId, `createMarket reverted (${hash})`);
    return { ok: false, error: 'createMarket reverted', code: 'tx' };
  }
  const id = marketIdFromReceipt(receipt);
  if (id === null) {
    await registry.markFailed(rowId, `no MarketCreated event in ${hash}`);
    return { ok: false, error: 'No MarketCreated event', code: 'tx' };
  }
  await registry.markOpen(rowId, {
    onchainMarketId: id.toString(),
    createdBlock: Number(receipt.blockNumber),
    createTx: hash,
  });
  const row = await registry.getBoundedMarket(rowId);
  return row ? { ok: true, row } : { ok: false, error: 'Row vanished', code: 'tx' };
}
