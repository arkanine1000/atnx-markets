import { PublicKey } from '@solana/web3.js';
import { createAdminClient } from '@/lib/supabase/admin';
import type { BmAnteSide, BmRoundRow, BmSeriesRow } from '@/lib/supabase/database-bm';
import { MAX_VI_AGE_MIN, readLiveVi, viIsFresh } from './open';
import * as rr from './rounds-registry';
import type { ClaimSeriesInput, RoundWithSeries } from './rounds-registry';
import { averageVi, fromE2, settleWindow, toE2, winnerOf } from './settle';
import {
  PROGRAM_ID,
  SOL_CHAIN_KEY,
  USDG_DECIMALS,
  ensureKeeperUsdg,
  keeperKeypair,
  pdas,
  readRound,
  newSeriesRef,
  readSeries,
  refFromHex,
  refToHex,
  sendCommit,
  sendCreateSeries,
  sendOpenRound,
  sendSetSeries,
  sendSettle,
  sendVoid,
  type RoundAccount,
  type RoundSide,
  type SeriesAccount,
} from './sol';

// Rolling VI rounds: starting a series on an atnx market, and the
// keeper's rounds step. The program (programs/vi_rounds) holds the money
// and enforces the rules; this file decides when to call it and keeps the
// registry (bm.series, bm.rounds) in step with it. Whenever the two
// disagree, the chain wins.
//
// One tick, in this order (settling N frees the live slot that opening
// N+1 needs, and opening N+1 frees the presale slot for N+2):
//
//   1. reconcile rounds a previous run left `opening` or `settling`;
//   2. pending series (start crashed half way) → create on chain;
//   3. live rounds past close + delay → average the window's VI prints →
//      settle (or void when no print arrived 30 minutes after the close);
//   4. presale rounds whose time has come → ante an empty side → open at
//      the current VI → insert the next presale, opening at the close;
//   5. paused series → void their presale round (refunds; the series ends).
//
// Dry mode reads everything and logs `would-*`, and writes nothing.

export function roundsEnabled(): boolean {
  return process.env.BM_ROUNDS_ENABLED === '1';
}

function envNum(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw === '') return fallback;
  const v = Number(raw);
  return Number.isFinite(v) && v >= min ? v : fallback;
}

export interface RoundParams {
  roundSecs: number;
  settleWindowSecs: number;
  firstPresaleSecs: number;
  anteUsdg: number;
}

export function roundParams(fast: boolean): RoundParams {
  return fast
    ? {
        roundSecs: envNum('BM_FAST_ROUND_SECS', 3600),
        settleWindowSecs: envNum('BM_FAST_SETTLE_WINDOW_SECS', 900),
        firstPresaleSecs: envNum('BM_FAST_FIRST_PRESALE_SECS', 600, 0),
        anteUsdg: envNum('BM_ANTE_USDG', 10),
      }
    : {
        roundSecs: envNum('BM_ROUND_SECS', 86400),
        settleWindowSecs: envNum('BM_SETTLE_WINDOW_SECS', 1800),
        firstPresaleSecs: envNum('BM_FIRST_PRESALE_SECS', 3600, 0),
        anteUsdg: envNum('BM_ANTE_USDG', 10),
      };
}

// Settle this long after the close, so the window's last prints land.
export const SETTLE_DELAY_SECS = envNum('BM_SETTLE_DELAY_SECS', 300, 0);
// A live round with no print in its window is voided this long after
// its close (everyone is refunded).
const VOID_AFTER_MS = 30 * 60_000;
// A row in flight (or a pending series) younger than this may belong to a
// run that is still going; leave it alone.
const IN_FLIGHT_GRACE_MS = 2 * 60_000;

const USDG_UNITS = 10 ** USDG_DECIMALS;

function usdgUnits(usdg: number): bigint {
  return BigInt(Math.round(usdg * USDG_UNITS));
}

function unitsUsdg(units: bigint): number {
  return Number(units) / USDG_UNITS;
}

function isoFromUnix(secs: number): string {
  return new Date(secs * 1000).toISOString();
}

// The series reference as stored at start; never recomputed from the
// market id, since each series carries its own nonce.
function refOf(series: BmSeriesRow): Uint8Array {
  return refFromHex(series.reference);
}

function key(k: PublicKey | string): string {
  return typeof k === 'string' ? k : k.toBase58();
}

// --------------------------------------------------------- start series

export type StartResult =
  | { ok: true; series: BmSeriesRow; round: BmRoundRow | null }
  | { ok: true; dry: true; plan: ClaimSeriesInput }
  | {
      ok: false;
      error: string;
      code: 'not_found' | 'scoring' | 'no_vi' | 'stale_vi' | 'already_active' | 'chain' | 'tx';
    };

export interface StartInput {
  atnxMarketId: string;
  finderWallet: string;
  finderUserId?: string | null;
  fast: boolean;
  dry?: boolean;
}

async function marketCreator(atnxMarketId: string): Promise<string | null> {
  const { data, error } = await createAdminClient()
    .from('markets')
    .select('created_by')
    .eq('id', atnxMarketId)
    .maybeSingle();
  if (error) throw error;
  return data?.created_by ?? null;
}

async function runningSeries(atnxMarketId: string, fast: boolean): Promise<boolean> {
  const { data, error } = await createAdminClient()
    .schema('bm')
    .from('series')
    .select('id')
    .eq('atnx_market_id', atnxMarketId)
    .eq('chain', SOL_CHAIN_KEY)
    .eq('fast', fast)
    .in('state', ['pending', 'active', 'paused'])
    .limit(1);
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// Starts a series of rounds on an atnx market: validates the VI, reserves
// the registry slot, creates the series (and round 1 in presale) on
// chain, and records round 1 with its presale open until now + the
// first presale length.
export async function startSeries(input: StartInput): Promise<StartResult> {
  const fast = !!input.fast;
  let finder: PublicKey;
  try {
    finder = new PublicKey(input.finderWallet);
  } catch {
    return { ok: false, error: 'bad wallet', code: 'chain' };
  }
  const programId = PROGRAM_ID.toBase58();

  const snap = await readLiveVi(input.atnxMarketId);
  if (!snap) return { ok: false, error: 'Market not found', code: 'not_found' };
  if (snap.state === 'scoring') return { ok: false, error: 'Market is still being scored', code: 'scoring' };
  if (!(snap.vi > 0)) return { ok: false, error: 'Market has no score yet', code: 'no_vi' };
  if (!viIsFresh(snap.updatedAt)) {
    return { ok: false, error: `The VI has not been updated for over ${MAX_VI_AGE_MIN} minutes`, code: 'stale_vi' };
  }
  if (await runningSeries(input.atnxMarketId, fast)) {
    return { ok: false, error: 'Rounds are already running on this market', code: 'already_active' };
  }

  const params = roundParams(fast);
  const ref = newSeriesRef(input.atnxMarketId, fast);
  const plan: ClaimSeriesInput = {
    atnxMarketId: input.atnxMarketId,
    chain: SOL_CHAIN_KEY,
    programId,
    reference: refToHex(ref),
    finderWallet: finder.toBase58(),
    finderUserId: input.finderUserId ?? (await marketCreator(input.atnxMarketId)),
    fast,
    ...params,
  };
  if (input.dry) return { ok: true, dry: true, plan };

  const row = await rr.claimSeries(plan);
  if (!row) return { ok: false, error: 'Rounds are already running on this market', code: 'already_active' };

  try {
    const existing = await readSeries(pdas(ref).series);
    if (existing) return await adoptSeries(row, existing, null);
    const res = await sendCreateSeries({
      ref,
      roundSecs: params.roundSecs,
      settleWindowSecs: params.settleWindowSecs,
      ante: usdgUnits(params.anteUsdg),
      finder,
    });
    await rr.markSeriesActive(row.id, { series_pubkey: key(res.series), create_tx: res.sig });
    const round =
      (await rr.insertPresale(row.id, 1, new Date(Date.now() + params.firstPresaleSecs * 1000), key(res.round))) ??
      (await rr.getRound(row.id, 1));
    return { ok: true, series: (await rr.getSeries(row.id)) ?? row, round };
  } catch (err) {
    const msg = (err as Error).message ?? String(err);
    console.error('[rounds] start failed', msg);
    // The send may have landed even though the call threw (a confirmation
    // timeout); the chain decides.
    const landed = await readSeries(pdas(ref).series).catch(() => null);
    if (landed) {
      try {
        return await adoptSeries(row, landed, null);
      } catch (err2) {
        return { ok: false, error: (err2 as Error).message, code: 'tx' };
      }
    }
    await rr.markSeriesFailed(row.id, msg);
    return { ok: false, error: msg, code: 'tx' };
  }
}

// A pending registry row whose series exists on chain: mark it active and
// record its presale round. A series account with neither a presale nor
// a live round has ended. References carry a time nonce, so a fresh start
// never lands on an ended series; the check stays as a guard.
async function adoptSeries(row: BmSeriesRow, acct: SeriesAccount, sig: string | null): Promise<StartResult> {
  const p = pdas(refOf(row));
  if (acct.presaleRound === 0 && acct.liveRound === 0) {
    const reason = 'this series reference belongs to an ended series on chain';
    await rr.markSeriesFailed(row.id, reason);
    return { ok: false, error: reason, code: 'chain' };
  }
  await rr.markSeriesActive(row.id, { series_pubkey: p.series.toBase58(), create_tx: sig ?? row.create_tx });
  let round: BmRoundRow | null = null;
  if (acct.presaleRound > 0) {
    const opensAt = new Date(new Date(row.created_at).getTime() + row.first_presale_secs * 1000);
    round =
      (await rr.insertPresale(row.id, acct.presaleRound, opensAt, p.round(acct.presaleRound).toBase58())) ??
      (await rr.getRound(row.id, acct.presaleRound));
  }
  return { ok: true, series: (await rr.getSeries(row.id)) ?? row, round };
}

// ------------------------------------------------------------ settlement

// The mean of the VI prints recorded in [close − window, close]. Filtered
// on recorded_at, never on id: seed rows are inserted later with
// backdated timestamps.
export async function settlementAverage(
  atnxMarketId: string,
  closeAt: Date,
  windowSecs: number
): Promise<{ avg: number | null; prints: number }> {
  const { from, to } = settleWindow(closeAt, windowSecs);
  const { data, error } = await createAdminClient()
    .from('vi_history')
    .select('vi, recorded_at')
    .eq('market_id', atnxMarketId)
    .gte('recorded_at', from.toISOString())
    .lte('recorded_at', to.toISOString())
    .limit(5000);
  if (error) throw error;
  const prints = (data ?? []).map((r) => ({ vi: Number(r.vi) }));
  return { avg: averageVi(prints), prints: prints.length };
}

// ------------------------------------------------------------------ tick

export interface RoundsCounts {
  settled: number;
  opened: number;
  anted: number;
  voided: number;
  reconciled: number;
  errors: number;
}

export type RoundsLog = (entry: {
  action: string;
  seriesId?: string | null;
  roundId?: string | null;
  detail?: Record<string, unknown> | null;
  error?: string | null;
  txHash?: string | null;
}) => Promise<void>;

export interface TickContext {
  dry: boolean;
  log: RoundsLog;
  rep: RoundsCounts;
  // Epoch ms after which no new work starts.
  deadline: number;
}

function ids(r: RoundWithSeries) {
  return { seriesId: r.series_id, roundId: r.id };
}

function olderThan(iso: string, ms: number): boolean {
  return Date.now() - new Date(iso).getTime() > ms;
}

export async function tickRounds(ctx: TickContext): Promise<void> {
  const { dry, log, rep } = ctx;
  let stopped = false;
  const late = () => {
    if (Date.now() <= ctx.deadline) return false;
    stopped = true;
    return true;
  };
  const fail = async (action: string, err: unknown, extra: Parameters<RoundsLog>[0] = { action }) => {
    rep.errors++;
    await log({ ...extra, action, error: (err as Error)?.message ?? String(err) });
  };

  // 1. reconcile rounds left in flight
  for (const r of await rr.listInFlight()) {
    if (late()) break;
    if (!olderThan(r.updated_at, IN_FLIGHT_GRACE_MS)) continue;
    try {
      const acct = await readRound(pdas(refOf(r.series)).round(r.idx));
      if (!acct) throw new Error('round account not found on chain');
      if (dry) {
        await log({ action: 'would-reconcile', ...ids(r), detail: { registry: r.state, chain: acct.state } });
        continue;
      }
      if (await syncFromChain(r, acct, null)) {
        rep.reconciled++;
        await log({ action: 'reconciled', ...ids(r), detail: { registry: r.state, chain: acct.state } });
        continue;
      }
      // The chain never moved: the transaction did not land. Put the row
      // back so this tick (steps 3 and 4) tries again.
      const back = r.state === 'opening' ? 'presale' : 'live';
      if ((r.state === 'opening' && acct.state === 'presale') || (r.state === 'settling' && acct.state === 'live')) {
        await rr.transitionRound(r.id, r.state, back, { error: `${r.state} did not land; retrying` });
        rep.reconciled++;
        await log({ action: 'reconcile-retry', ...ids(r), detail: { from: r.state, to: back } });
      } else {
        throw new Error(`registry ${r.state}, chain ${acct.state}`);
      }
    } catch (err) {
      await fail('reconcile', err, { action: 'reconcile', ...ids(r) });
    }
  }

  // 2. pending series
  for (const s of await rr.listPendingSeries()) {
    if (late()) break;
    if (!olderThan(s.created_at, IN_FLIGHT_GRACE_MS)) continue;
    const at = { seriesId: s.id };
    try {
      const ref = refOf(s);
      const acct = await readSeries(pdas(ref).series);
      if (dry) {
        await log({ action: acct ? 'would-activate' : 'would-create', ...at, detail: { atnxMarketId: s.atnx_market_id, fast: s.fast } });
        continue;
      }
      if (acct) {
        const res = await adoptSeries(s, acct, null);
        if (res.ok) rep.reconciled++;
        await log({ action: res.ok ? 'series-adopted' : 'series-failed', ...at, error: res.ok ? null : res.error });
        continue;
      }
      try {
        const res = await sendCreateSeries({
          ref,
          roundSecs: s.round_secs,
          settleWindowSecs: s.settle_window_secs,
          ante: usdgUnits(Number(s.ante_usdg)),
          finder: new PublicKey(s.finder_wallet),
        });
        await rr.markSeriesActive(s.id, { series_pubkey: key(res.series), create_tx: res.sig });
        await rr.insertPresale(s.id, 1, new Date(Date.now() + s.first_presale_secs * 1000), key(res.round));
        await log({ action: 'series-created', ...at, txHash: res.sig });
      } catch (err) {
        const landed = await readSeries(pdas(ref).series).catch(() => null);
        if (landed) {
          await adoptSeries(s, landed, null);
          await log({ action: 'series-adopted', ...at });
        } else {
          await rr.markSeriesFailed(s.id, (err as Error).message ?? String(err));
          throw err;
        }
      }
    } catch (err) {
      await fail('create-series', err, { action: 'create-series', ...at });
    }
  }

  // 3. due live rounds
  for (const r of await rr.listDueLive(new Date(), SETTLE_DELAY_SECS)) {
    if (late()) break;
    try {
      const ref = refOf(r.series);
      const roundKey = pdas(ref).round(r.idx);
      const acct = await readRound(roundKey);
      if (!acct) throw new Error('round account not found on chain');
      if (acct.state !== 'live') {
        if (dry) {
          await log({ action: 'would-reconcile', ...ids(r), detail: { registry: r.state, chain: acct.state } });
        } else if (await syncFromChain(r, acct, null)) {
          rep.reconciled++;
          await log({ action: 'reconciled', ...ids(r), detail: { registry: r.state, chain: acct.state } });
        } else {
          throw new Error(`registry live, chain ${acct.state}`);
        }
        continue;
      }
      const closeAt = new Date(acct.closeAt * 1000);
      const { avg, prints } = await settlementAverage(r.series.atnx_market_id, closeAt, r.series.settle_window_secs);

      if (avg === null) {
        if (Date.now() < closeAt.getTime() + VOID_AFTER_MS) {
          await log({ action: 'settle-waiting', ...ids(r), detail: { reason: 'no prints in the window yet' } });
          continue;
        }
        if (dry) {
          rep.voided++;
          await log({ action: 'would-void', ...ids(r), detail: { reason: 'no prints in the settlement window' } });
          continue;
        }
        if (!(await rr.transitionRound(r.id, 'live', 'settling', { settle_prints: 0 }))) {
          await log({ action: 'skip-concurrent', ...ids(r) });
          continue;
        }
        const sig = await sendVoid({ ref, roundIndex: r.idx });
        await rr.transitionRound(r.id, 'settling', 'void', { void_tx: sig, error: 'no VI prints in the settlement window' });
        rep.voided++;
        await log({ action: 'voided', ...ids(r), txHash: sig, detail: { reason: 'no prints' } });
        await maybeEndSeries(r.series);
        continue;
      }

      const settleE2 = toE2(avg);
      const winner = winnerOf(settleE2, acct.targetE2);
      const detail = { avg, prints, target: fromE2(acct.targetE2), winner };
      if (dry) {
        rep.settled++;
        await log({ action: 'would-settle', ...ids(r), detail });
        continue;
      }
      if (!(await rr.transitionRound(r.id, 'live', 'settling', { settle_vi: avg, settle_prints: prints }))) {
        await log({ action: 'skip-concurrent', ...ids(r) });
        continue;
      }
      const sig = await sendSettle({ ref, roundIndex: r.idx, settleE2 });
      const after = await readRound(roundKey).catch(() => null);
      await rr.transitionRound(r.id, 'settling', 'settled', {
        winner: after?.winner ?? winner,
        settle_vi: avg,
        settle_prints: prints,
        settle_tx: sig,
        error: null,
      });
      rep.settled++;
      await log({ action: 'settled', ...ids(r), txHash: sig, detail });
      await maybeEndSeries(r.series);
    } catch (err) {
      // A row left `settling` is reconciled from the chain next tick.
      await fail('settle', err, { action: 'settle', ...ids(r) });
    }
  }

  // 4. presale rounds ready to open
  for (const r of await rr.listPresaleReady(new Date())) {
    if (late()) break;
    try {
      const ref = refOf(r.series);
      const p = pdas(ref);
      const roundKey = p.round(r.idx);
      const acct = await readRound(roundKey);
      if (!acct) throw new Error('round account not found on chain');
      if (acct.state !== 'presale') {
        // Opened (or ended) by a run whose bookkeeping did not finish.
        if (dry) {
          await log({ action: 'would-reconcile', ...ids(r), detail: { registry: r.state, chain: acct.state } });
        } else if (await syncFromChain(r, acct, null)) {
          rep.reconciled++;
          await log({ action: 'reconciled', ...ids(r), detail: { registry: r.state, chain: acct.state } });
        } else {
          throw new Error(`registry presale, chain ${acct.state}`);
        }
        continue;
      }
      const chainSeries = await readSeries(p.series);
      if (!chainSeries) throw new Error('series account not found on chain');
      if (chainSeries.paused) {
        await log({ action: 'open-deferred', ...ids(r), detail: { reason: 'series paused on chain' } });
        continue;
      }
      if (chainSeries.liveRound !== 0 || chainSeries.presaleRound !== r.idx) {
        throw new Error(`chain series live ${chainSeries.liveRound}, presale ${chainSeries.presaleRound}; registry presale ${r.idx}`);
      }

      // The VI first: no ante on a round that cannot open yet.
      const snap = await readLiveVi(r.series.atnx_market_id);
      const reason = !snap
        ? 'market not found'
        : snap.state === 'scoring'
          ? 'market is being scored'
          : !(snap.vi > 0)
            ? 'no VI'
            : !viIsFresh(snap.updatedAt)
              ? `VI older than ${MAX_VI_AGE_MIN} minutes`
              : null;
      if (reason || !snap) {
        await log({ action: 'open-deferred', ...ids(r), detail: { reason } });
        continue;
      }

      // Both pots need money for the opening prices; the keeper antes an
      // empty side with an ordinary commit it can win or lose.
      const empty: RoundSide[] = [];
      if (acct.presaleUp === 0n) empty.push('up');
      if (acct.presaleDown === 0n) empty.push('down');
      if (empty.length > 0) {
        const ante = chainSeries.ante > 0n ? chainSeries.ante : usdgUnits(Number(r.series.ante_usdg));
        const anteSide: BmAnteSide = empty.length === 2 ? 'both' : empty[0];
        const anteDetail = { side: anteSide, usdg: unitsUsdg(ante) };
        if (dry) {
          rep.anted++;
          await log({ action: 'would-ante', ...ids(r), detail: anteDetail });
        } else {
          await ensureKeeperUsdg(ante * BigInt(empty.length));
          for (const side of empty) {
            const sig = await sendCommit({ ref, roundIndex: r.idx, side, amount: ante });
            await log({ action: 'anted', ...ids(r), txHash: sig, detail: { side, usdg: unitsUsdg(ante) } });
          }
          await rr.updateRound(r.id, { ante_side: anteSide, ante_usdg: unitsUsdg(ante) * empty.length });
          rep.anted++;
        }
      }

      const targetE2 = toE2(snap.vi);
      if (dry) {
        rep.opened++;
        await log({
          action: 'would-open',
          ...ids(r),
          detail: { target: fromE2(targetE2), presaleUp: unitsUsdg(acct.presaleUp), presaleDown: unitsUsdg(acct.presaleDown) },
        });
        continue;
      }
      if (!(await rr.transitionRound(r.id, 'presale', 'opening', { target_vi: fromE2(targetE2) }))) {
        await log({ action: 'skip-concurrent', ...ids(r) });
        continue;
      }
      // From here a failure leaves the row `opening`; step 1 of a later
      // tick reads the chain and finishes or retries it.
      const res = await sendOpenRound({ ref, roundIndex: r.idx, targetE2 });
      const after = await readRound(roundKey);
      if (!after || after.state !== 'live') throw new Error('open_round sent but the round is not live yet');
      await finishOpen(r, after, res.sig, key(res.nextRound));
      rep.opened++;
      await log({
        action: 'opened',
        ...ids(r),
        txHash: res.sig,
        detail: { target: fromE2(after.targetE2), closeAt: isoFromUnix(after.closeAt), presaleUp: unitsUsdg(after.presaleUp), presaleDown: unitsUsdg(after.presaleDown) },
      });
    } catch (err) {
      await fail('open', err, { action: 'open', ...ids(r) });
    }
  }

  // 5. paused series: void the presale round (refunds), which ends the
  // series on chain.
  for (const r of await rr.listPausedWithPresale()) {
    if (late()) break;
    try {
      const ref = refOf(r.series);
      const p = pdas(ref);
      const acct = await readRound(p.round(r.idx));
      if (dry) {
        rep.voided++;
        await log({ action: 'would-void', ...ids(r), detail: { reason: 'series paused', chain: acct?.state ?? null } });
        continue;
      }
      if (acct && acct.state === 'void') {
        await rr.transitionRound(r.id, 'presale', 'void', {});
      } else {
        const chainSeries = await readSeries(p.series);
        if (chainSeries && !chainSeries.paused) await sendSetSeries({ ref, paused: true });
        const sig = await sendVoid({ ref, roundIndex: r.idx });
        await rr.transitionRound(r.id, 'presale', 'void', { void_tx: sig, error: 'series paused' });
        await log({ action: 'voided', ...ids(r), txHash: sig, detail: { reason: 'series paused' } });
      }
      rep.voided++;
      await maybeEndSeries(r.series);
    } catch (err) {
      await fail('void', err, { action: 'void', ...ids(r) });
    }
  }

  if (stopped) await log({ action: 'rounds-deadline', detail: { note: 'stopped starting new work; the next tick resumes' } });
}

// Brings a registry row in line with the chain's round. Returns false when
// the chain shows nothing the row does not already know.
async function syncFromChain(r: RoundWithSeries, acct: RoundAccount, sig: string | null): Promise<boolean> {
  if (acct.state === 'live' && (r.state === 'opening' || r.state === 'presale')) {
    await finishOpen(r, acct, sig, pdas(refOf(r.series)).round(r.idx + 1).toBase58());
    return true;
  }
  if (acct.state === 'settled' && r.state !== 'settled') {
    await rr.transitionRound(r.id, ['opening', 'live', 'settling'], 'settled', {
      winner: acct.winner,
      settle_vi: fromE2(acct.settleE2),
      target_vi: fromE2(acct.targetE2),
      settle_tx: sig ?? r.settle_tx,
      error: null,
    });
    await maybeEndSeries(r.series);
    return true;
  }
  if (acct.state === 'void' && r.state !== 'void') {
    await rr.transitionRound(r.id, ['presale', 'opening', 'live', 'settling'], 'void', { void_tx: sig ?? r.void_tx });
    await maybeEndSeries(r.series);
    return true;
  }
  return false;
}

// Marks an opened round live with the chain's numbers, then records the
// next round's presale, opening when this one closes.
async function finishOpen(r: RoundWithSeries, acct: RoundAccount, sig: string | null, nextRoundKey: string): Promise<void> {
  const patch: Partial<BmRoundRow> = {
    opened_at: isoFromUnix(acct.openedAt),
    close_at: isoFromUnix(acct.closeAt),
    trade_until: isoFromUnix(acct.tradeUntil),
    target_vi: fromE2(acct.targetE2),
    presale_up_usdg: unitsUsdg(acct.presaleUp),
    presale_down_usdg: unitsUsdg(acct.presaleDown),
    round_pubkey: pdas(refOf(r.series)).round(r.idx).toBase58(),
    open_tx: sig ?? r.open_tx,
    error: null,
  };
  await rr.transitionRound(r.id, ['opening', 'presale'], 'live', patch);
  await rr.insertPresale(r.series_id, r.idx + 1, patch.close_at!, nextRoundKey);
}

// A paused series with nothing left to settle or open has ended.
async function maybeEndSeries(series: BmSeriesRow): Promise<void> {
  const fresh = await rr.getSeries(series.id);
  if (!fresh || fresh.state !== 'paused') return;
  if (!(await rr.hasOpenRounds(series.id))) await rr.updateSeries(series.id, { state: 'ended' });
}

// The keeper's wallet, for scripts that default the finder to it.
export function keeperWallet(): string {
  return keeperKeypair().publicKey.toBase58();
}
