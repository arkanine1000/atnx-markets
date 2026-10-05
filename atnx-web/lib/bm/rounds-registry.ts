import { createAdminClient } from '@/lib/supabase/admin';
import type { BmRoundRow, BmRoundState, BmSeriesRow, BmSeriesState } from '@/lib/supabase/database-bm';

// The registry of rolling VI rounds (supabase/bm/002_rounds.sql): which
// atnx market has which on-chain series, and where each of its rounds
// stands. Written only through the service role, by the start-series
// action and the keeper. Commits, shares and payouts are not here; they
// are accounts in the vi_rounds program.
//
// A round moves presale → opening → live → settling → settled (or void).
// Every move is a compare-and-set on the current state, so two
// overlapping keeper runs cannot both send the same transaction; the
// partial unique indexes keep one presale and one live round per series.

export type { BmRoundRow, BmRoundState, BmSeriesRow, BmSeriesState };

const RUNNING_SERIES: BmSeriesState[] = ['active', 'paused'];
const IN_FLIGHT: BmRoundState[] = ['opening', 'live', 'settling'];

function bm() {
  return createAdminClient().schema('bm');
}

function now() {
  return new Date().toISOString();
}

// ---------------------------------------------------------------- series

export interface ClaimSeriesInput {
  atnxMarketId: string;
  chain: string;
  programId: string;
  reference: string;
  finderWallet: string;
  finderUserId?: string | null;
  roundSecs: number;
  settleWindowSecs: number;
  firstPresaleSecs: number;
  anteUsdg: number;
  fast: boolean;
}

// Reserves the one running series for (market, chain, speed) with a
// `pending` row. A second claim hits bm_series_one_active (23505) and
// comes back as null.
export async function claimSeries(input: ClaimSeriesInput): Promise<BmSeriesRow | null> {
  const { data, error } = await bm()
    .from('series')
    .insert({
      atnx_market_id: input.atnxMarketId,
      chain: input.chain,
      program_id: input.programId,
      reference: input.reference,
      finder_wallet: input.finderWallet,
      finder_user_id: input.finderUserId ?? null,
      round_secs: input.roundSecs,
      settle_window_secs: input.settleWindowSecs,
      first_presale_secs: input.firstPresaleSecs,
      ante_usdg: input.anteUsdg,
      fast: input.fast,
      state: 'pending',
    })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') return null;
    throw error;
  }
  return data as BmSeriesRow;
}

export async function updateSeries(id: string, patch: Partial<BmSeriesRow>): Promise<void> {
  const { error } = await bm()
    .from('series')
    .update({ ...patch, updated_at: now() })
    .eq('id', id);
  if (error) throw error;
}

export async function markSeriesActive(id: string, patch: { series_pubkey: string; create_tx?: string | null }): Promise<void> {
  return updateSeries(id, { ...patch, state: 'active', error: null });
}

export async function markSeriesFailed(id: string, reason: string): Promise<void> {
  return updateSeries(id, { state: 'failed', error: reason.slice(0, 500) });
}

export async function getSeries(id: string): Promise<BmSeriesRow | null> {
  const { data, error } = await bm().from('series').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return (data as BmSeriesRow | null) ?? null;
}

async function seriesByIds(ids: string[]): Promise<Map<string, BmSeriesRow>> {
  const out = new Map<string, BmSeriesRow>();
  const unique = Array.from(new Set(ids));
  if (unique.length === 0) return out;
  const { data, error } = await bm().from('series').select('*').in('id', unique);
  if (error) throw error;
  for (const s of (data ?? []) as BmSeriesRow[]) out.set(s.id, s);
  return out;
}

export async function listPendingSeries(): Promise<BmSeriesRow[]> {
  const { data, error } = await bm()
    .from('series')
    .select('*')
    .eq('state', 'pending')
    .order('created_at', { ascending: true })
    .limit(100);
  if (error) throw error;
  return (data ?? []) as BmSeriesRow[];
}

// The running series of one atnx market (the daily one first, then the
// fast demo one) with its rounds, newest first, for the market page.
export async function getSeriesForMarket(
  atnxMarketId: string
): Promise<{ series: BmSeriesRow; rounds: BmRoundRow[] } | null> {
  const { data, error } = await bm()
    .from('series')
    .select('*')
    .eq('atnx_market_id', atnxMarketId)
    .in('state', RUNNING_SERIES)
    .order('fast', { ascending: true })
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) throw error;
  if (!data) return null;
  const series = data as BmSeriesRow;
  return { series, rounds: await recentRounds(series.id, 50) };
}

// ---------------------------------------------------------------- rounds

// A new presale round. bm_rounds_one_presale and unique (series_id, idx)
// make a second insert fail with 23505, which comes back as null.
export async function insertPresale(
  seriesId: string,
  idx: number,
  opensAt: Date | string,
  roundPubkey: string | null
): Promise<BmRoundRow | null> {
  const { data, error } = await bm()
    .from('rounds')
    .insert({
      series_id: seriesId,
      idx,
      opens_at: typeof opensAt === 'string' ? opensAt : opensAt.toISOString(),
      round_pubkey: roundPubkey,
      state: 'presale',
    })
    .select('*')
    .single();
  if (error) {
    if (error.code === '23505') return null;
    throw error;
  }
  return data as BmRoundRow;
}

// Moves a round from one of `from` to `to` only if it is still there.
// False means someone else moved it first (or it was never there).
export async function transitionRound(
  id: string,
  from: BmRoundState | BmRoundState[],
  to: BmRoundState,
  patch: Partial<BmRoundRow> = {}
): Promise<boolean> {
  const states = Array.isArray(from) ? from : [from];
  const { data, error } = await bm()
    .from('rounds')
    .update({ ...patch, state: to, updated_at: now() })
    .eq('id', id)
    .in('state', states)
    .select('id');
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// A field update that leaves the state alone (the ante on a presale row).
export async function updateRound(id: string, patch: Partial<BmRoundRow>): Promise<void> {
  const { state: _ignored, ...rest } = patch;
  void _ignored;
  const { error } = await bm()
    .from('rounds')
    .update({ ...rest, updated_at: now() })
    .eq('id', id);
  if (error) throw error;
}

export async function getRound(seriesId: string, idx: number): Promise<BmRoundRow | null> {
  const { data, error } = await bm().from('rounds').select('*').eq('series_id', seriesId).eq('idx', idx).maybeSingle();
  if (error) throw error;
  return (data as BmRoundRow | null) ?? null;
}

export async function recentRounds(seriesId: string, limit = 20): Promise<BmRoundRow[]> {
  const { data, error } = await bm()
    .from('rounds')
    .select('*')
    .eq('series_id', seriesId)
    .order('idx', { ascending: false })
    .limit(limit);
  if (error) throw error;
  return (data ?? []) as BmRoundRow[];
}

export type RoundWithSeries = BmRoundRow & { series: BmSeriesRow };

async function withSeries(rows: BmRoundRow[]): Promise<RoundWithSeries[]> {
  const series = await seriesByIds(rows.map((r) => r.series_id));
  const out: RoundWithSeries[] = [];
  for (const r of rows) {
    const s = series.get(r.series_id);
    if (s) out.push({ ...r, series: s });
  }
  return out;
}

// Live rounds whose close is at least `delaySecs` behind: the settlement
// window has closed and the last prints in it have had time to land.
export async function listDueLive(at: Date, delaySecs: number): Promise<RoundWithSeries[]> {
  const cutoff = new Date(at.getTime() - delaySecs * 1000).toISOString();
  const { data, error } = await bm()
    .from('rounds')
    .select('*')
    .eq('state', 'live')
    .lte('close_at', cutoff)
    .order('close_at', { ascending: true })
    .limit(100);
  if (error) throw error;
  return withSeries((data ?? []) as BmRoundRow[]);
}

// Presale rounds that may open now: their time has come, their series is
// active, and the series has no round opening, live or settling.
export async function listPresaleReady(at: Date): Promise<RoundWithSeries[]> {
  const { data, error } = await bm()
    .from('rounds')
    .select('*')
    .eq('state', 'presale')
    .lte('opens_at', at.toISOString())
    .order('opens_at', { ascending: true })
    .limit(100);
  if (error) throw error;
  const rows = await withSeries((data ?? []) as BmRoundRow[]);
  const active = rows.filter((r) => r.series.state === 'active');
  if (active.length === 0) return [];
  const { data: busy, error: busyErr } = await bm()
    .from('rounds')
    .select('series_id')
    .in('series_id', Array.from(new Set(active.map((r) => r.series_id))))
    .in('state', IN_FLIGHT);
  if (busyErr) throw busyErr;
  const blocked = new Set((busy ?? []).map((b) => b.series_id));
  return active.filter((r) => !blocked.has(r.series_id));
}

// Rounds a keeper run left mid-transaction.
export async function listInFlight(): Promise<RoundWithSeries[]> {
  const { data, error } = await bm()
    .from('rounds')
    .select('*')
    .in('state', ['opening', 'settling'])
    .order('updated_at', { ascending: true })
    .limit(100);
  if (error) throw error;
  return withSeries((data ?? []) as BmRoundRow[]);
}

// Paused series that still hold a presale round (to be voided, which
// ends the series on chain).
export async function listPausedWithPresale(): Promise<RoundWithSeries[]> {
  const { data: paused, error } = await bm().from('series').select('*').eq('state', 'paused').limit(100);
  if (error) throw error;
  const series = (paused ?? []) as BmSeriesRow[];
  if (series.length === 0) return [];
  const { data, error: rErr } = await bm()
    .from('rounds')
    .select('*')
    .in('series_id', series.map((s) => s.id))
    .eq('state', 'presale');
  if (rErr) throw rErr;
  const byId = new Map(series.map((s) => [s.id, s]));
  return ((data ?? []) as BmRoundRow[]).map((r) => ({ ...r, series: byId.get(r.series_id)! }));
}

// Whether a series still has a round that is not finished.
export async function hasOpenRounds(seriesId: string): Promise<boolean> {
  const { data, error } = await bm()
    .from('rounds')
    .select('id')
    .eq('series_id', seriesId)
    .in('state', ['presale', ...IN_FLIGHT])
    .limit(1);
  if (error) throw error;
  return (data?.length ?? 0) > 0;
}

// The live and presale rounds of every running series, for the listing
// badges and /api/bm/rounds.
export async function listLiveRounds(): Promise<RoundWithSeries[]> {
  const { data, error } = await bm()
    .from('rounds')
    .select('*')
    .in('state', ['presale', ...IN_FLIGHT])
    .order('opens_at', { ascending: true })
    .limit(500);
  if (error) throw error;
  const rows = await withSeries((data ?? []) as BmRoundRow[]);
  return rows.filter((r) => RUNNING_SERIES.includes(r.series.state));
}
