import { randomUUID } from 'node:crypto';
import { createAdminClient } from '@/lib/supabase/admin';
import { chainByKey, type BmChain } from './chains';
import { applyPrints, type Print } from './keeper';
import {
  INDEX_SIDE,
  MARKET_STATUS,
  getReceipt,
  readMarket,
  sendResolve,
  waitReceipt,
} from './evm';
import { finishCreate, openBoundedMarket } from './open';
import * as registry from './registry';
import type { BmMarketRow, BmSide } from '@/lib/supabase/database-bm';

// One keeper tick, for both kinds of on-chain market: the bounded markets
// of the first iteration (EVM testnets, steps 1–3) and the rolling VI
// rounds on Solana devnet (step 4). Runs from the cron route
// (/api/bm/keeper) every five minutes and by hand from
// scripts/bm-keeper-dry.ts and scripts/rounds-tick.ts. In dry mode nothing
// is sent and nothing in the registry changes; the log says what would
// happen.
//
//   1. pending bounded markets: the create tx was sent but the open call
//      did not see it confirm; look the receipt up and finish or fail the
//      row.
//   2. resolving bounded markets: same for the resolve tx; the chain is
//      the truth.
//   3. open bounded markets: read the VI prints since the cursor, apply
//      the touch rule, advance the cursor; on a touch, resolve on-chain,
//      then auto-roll a new market from the current VI (unless
//      BM_AUTO_ROLL=0).
//   4. rolling rounds (BM_ROUNDS_ENABLED=1): see tickRounds in rounds.ts
//      (reconcile, create pending series, settle or void, ante and open,
//      void the presale of paused series). It stops starting new work 45
//      seconds into the tick; the next tick picks up where it left off.
//
// Every non-dry entry lands in bm.keeper_log: bounded entries carry
// bm_market_id, rounds entries series_id and round_id. A failure on one
// market or round is logged and the loop moves on.

export const TOUCH_PRINTS = Number(process.env.BM_TOUCH_PRINTS ?? 3);
export const AUTO_ROLL = (process.env.BM_AUTO_ROLL ?? '1') !== '0';
const RESEND_AFTER_MS = 10 * 60_000;
const ROUNDS_BUDGET_MS = 45_000;
// Same test as roundsEnabled() in rounds.ts, kept here so the bounded
// keeper only loads the Solana client (through rounds.ts) when rounds are on.
const ROUNDS_ON = () => process.env.BM_ROUNDS_ENABLED === '1';

export interface KeeperReport {
  runId: string;
  dry: boolean;
  checked: number;
  resolved: number;
  rolled: number;
  reconciled: number;
  errors: number;
  // Rolling rounds (zero unless BM_ROUNDS_ENABLED=1).
  settled: number;
  opened: number;
  anted: number;
  voided: number;
  claimed: number;
  notes: string[];
}

// Prints after the cursor and after the row was created: a market only
// ever resolves on what the VI did while it was open.
async function printsSince(atnxMarketId: string, cursor: number, since: string, limit = 500): Promise<Print[]> {
  const { data, error } = await createAdminClient()
    .from('vi_history')
    .select('id, vi')
    .eq('market_id', atnxMarketId)
    .gt('id', cursor)
    .gte('recorded_at', since)
    .order('id', { ascending: true })
    .limit(limit);
  if (error) throw error;
  return (data ?? []).map((r) => ({ id: Number(r.id), vi: Number(r.vi) }));
}

function chainOf(row: BmMarketRow): BmChain {
  const c = chainByKey(row.chain);
  if (!c) throw new Error(`unknown chain ${row.chain}`);
  return c;
}

export async function runKeeper(opts: { dry?: boolean } = {}): Promise<KeeperReport> {
  const dry = !!opts.dry;
  const startedAt = Date.now();
  const runId = randomUUID();
  const rep: KeeperReport = {
    runId,
    dry,
    checked: 0,
    resolved: 0,
    rolled: 0,
    reconciled: 0,
    errors: 0,
    settled: 0,
    opened: 0,
    anted: 0,
    voided: 0,
    claimed: 0,
    notes: [],
  };
  const log = (entry: Omit<Parameters<typeof registry.logKeeper>[0], 'runId'>) => {
    const subject = entry.marketId ?? entry.roundId ?? entry.seriesId;
    // Rounds entries carry their numbers in the note (would-settle's
    // average, would-open's target) so a dry run reads on its own.
    const detail = !entry.marketId && subject && entry.detail ? ` ${JSON.stringify(entry.detail)}` : '';
    rep.notes.push(`${entry.action}${subject ? ` ${subject.slice(0, 8)}` : ''}${detail}${entry.error ? `: ${entry.error}` : ''}`);
    if (!dry) return registry.logKeeper({ runId, ...entry });
    return Promise.resolve();
  };

  await log({ action: 'tick', detail: { dry, touchPrints: TOUCH_PRINTS, autoRoll: AUTO_ROLL, rounds: ROUNDS_ON() } });

  // 1. pending
  for (const row of await registry.listByState(['pending'])) {
    try {
      if (!row.create_tx) {
        // Claimed but the send never happened (crash before the tx).
        const age = Date.now() - new Date(row.created_at).getTime();
        if (age > RESEND_AFTER_MS && !dry) await registry.markFailed(row.id, 'no create tx within 10 minutes');
        continue;
      }
      const receipt = await getReceipt(chainOf(row), row.create_tx as `0x${string}`);
      if (!receipt) continue;
      if (!dry) await finishCreate(chainOf(row), row.id, row.create_tx as `0x${string}`, receipt);
      rep.reconciled++;
      await log({ action: 'reconcile-open', marketId: row.id, txHash: row.create_tx });
    } catch (err) {
      rep.errors++;
      await log({ action: 'reconcile-open', marketId: row.id, error: (err as Error).message });
    }
  }

  // 2. resolving
  for (const row of await registry.listByState(['resolving'])) {
    try {
      const chain = chainOf(row);
      const onchain = row.onchain_market_id ? await readMarket(chain, BigInt(row.onchain_market_id)) : null;
      if (onchain && onchain.status === MARKET_STATUS.resolved) {
        const side = INDEX_SIDE[onchain.winner];
        if (!dry) await registry.markResolved(row.id, { side, vi: Number(onchain.resolvedViE2) / 100, tx: row.resolve_tx });
        rep.reconciled++;
        await log({ action: 'reconcile-resolved', marketId: row.id, txHash: row.resolve_tx });
        if (AUTO_ROLL) await roll(row, rep, log, dry);
        continue;
      }
      const age = Date.now() - new Date(row.updated_at).getTime();
      if (age > RESEND_AFTER_MS && row.streak_side) {
        await resolveOnChain(row, row.streak_side, Number(row.resolved_vi ?? row.start_vi), rep, log, dry);
      }
    } catch (err) {
      rep.errors++;
      await log({ action: 'reconcile-resolve', marketId: row.id, error: (err as Error).message });
    }
  }

  // 3. open
  for (const row of await registry.listByState(['open'])) {
    rep.checked++;
    try {
      const prints = await printsSince(row.atnx_market_id, row.keeper_cursor, row.created_at);
      if (prints.length === 0) continue;
      const result = applyPrints(
        { cursor: row.keeper_cursor, streakSide: row.streak_side, streakCount: row.streak_count },
        prints,
        { lower: row.lower_bound, upper: row.upper_bound },
        TOUCH_PRINTS
      );
      if (!dry) {
        const moved = await registry.advanceCursor(row.id, row.keeper_cursor, {
          cursor: result.state.cursor,
          streakSide: result.state.streakSide,
          streakCount: result.state.streakCount,
        });
        if (!moved) {
          await log({ action: 'skip-concurrent', marketId: row.id });
          continue;
        }
      }
      if (result.state.streakCount > 0 || result.touch) {
        await log({
          action: result.touch ? 'touch' : 'streak',
          marketId: row.id,
          detail: { prints: prints.length, ...result.state, touch: result.touch },
        });
      }
      if (result.touch) {
        await resolveOnChain(row, result.touch.side, result.touch.vi, rep, log, dry);
      }
    } catch (err) {
      rep.errors++;
      await log({ action: 'check', marketId: row.id, error: (err as Error).message });
    }
  }

  // 4. rolling rounds
  if (ROUNDS_ON()) {
    try {
      const { tickRounds } = await import('./rounds');
      await tickRounds({ dry, log, rep, deadline: startedAt + ROUNDS_BUDGET_MS });
    } catch (err) {
      rep.errors++;
      await log({ action: 'rounds', error: (err as Error).message });
    }
  }

  await log({ action: 'done', detail: { ...rep, notes: undefined } });
  return rep;
}

type Log = (entry: Omit<Parameters<typeof registry.logKeeper>[0], 'runId'>) => Promise<void>;

async function resolveOnChain(row: BmMarketRow, side: BmSide, vi: number, rep: KeeperReport, log: Log, dry: boolean) {
  const chain = chainOf(row);
  if (!row.onchain_market_id) throw new Error('open row without an on-chain id');
  const id = BigInt(row.onchain_market_id);
  const onchain = await readMarket(chain, id);
  if (onchain.status === MARKET_STATUS.resolved) {
    // Someone (a previous run) already did it; just sync.
    if (!dry) await registry.markResolved(row.id, { side: INDEX_SIDE[onchain.winner], vi: Number(onchain.resolvedViE2) / 100, tx: row.resolve_tx });
    rep.resolved++;
    await log({ action: 'resolved-already', marketId: row.id });
    if (AUTO_ROLL) await roll(row, rep, log, dry);
    return;
  }
  if (dry) {
    rep.resolved++;
    await log({ action: 'would-resolve', marketId: row.id, detail: { side, vi } });
    return;
  }
  const hash = await sendResolve(chain, id, side, vi);
  await registry.markResolving(row.id, hash);
  await registry.update(row.id, { resolved_vi: vi });
  await log({ action: 'resolve-sent', marketId: row.id, txHash: hash, detail: { side, vi } });
  const receipt = await waitReceipt(chain, hash);
  if (receipt.status !== 'success') {
    await log({ action: 'resolve-reverted', marketId: row.id, txHash: hash, error: 'reverted' });
    rep.errors++;
    return;
  }
  await registry.markResolved(row.id, { side, vi, tx: hash });
  rep.resolved++;
  await log({ action: 'resolved', marketId: row.id, txHash: hash, detail: { side, vi } });
  if (AUTO_ROLL) await roll(row, rep, log, dry);
}

async function roll(row: BmMarketRow, rep: KeeperReport, log: Log, dry: boolean) {
  const result = await openBoundedMarket({
    atnxMarketId: row.atnx_market_id,
    chainKey: row.chain,
    rolledFrom: row.id,
    roll: row.roll + 1,
    dry,
  });
  if (result.ok) {
    rep.rolled++;
    await log({ action: dry ? 'would-roll' : 'rolled', marketId: row.id, detail: { next: result.row.id, lower: result.row.lower_bound, upper: result.row.upper_bound } });
  } else {
    await log({ action: 'roll-skipped', marketId: row.id, error: `${result.code}: ${result.error}` });
  }
}
