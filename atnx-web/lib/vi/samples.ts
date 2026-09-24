// The vi_samples table (migration 016): raw readings over time for the
// sources that need their own history to measure momentum. Written and
// read with the service role from the refresh paths.
import { createAdminClient } from '../supabase/admin';
import type { Json } from '../supabase/database';

export interface Sample {
  sampled_at: string;
  value: number;
  meta: Record<string, string | number | boolean | null> | null;
}

export async function writeSample(
  marketId: string,
  source: string,
  value: number,
  meta: Record<string, string | number | boolean | null>,
  sampledAt = new Date().toISOString()
): Promise<void> {
  const { error } = await createAdminClient()
    .from('vi_samples')
    .insert({ market_id: marketId, source, sampled_at: sampledAt, value, meta: meta as Json });
  if (error) console.error(`[samples] write failed (${source}, ${marketId}): ${error.message}`);
}

// Newest first.
export async function readSamples(marketId: string, source: string, limit = 80): Promise<Sample[]> {
  const { data, error } = await createAdminClient()
    .from('vi_samples')
    .select('sampled_at, value, meta')
    .eq('market_id', marketId)
    .eq('source', source)
    .order('sampled_at', { ascending: false })
    .limit(limit);
  if (error) {
    console.error(`[samples] read failed (${source}, ${marketId}): ${error.message}`);
    return [];
  }
  return ((data ?? []) as unknown as Sample[]).map((s) => ({ ...s, value: Number(s.value) }));
}

export async function pruneSamples(marketId: string, source: string, keepMs: number): Promise<void> {
  await createAdminClient()
    .from('vi_samples')
    .delete()
    .eq('market_id', marketId)
    .eq('source', source)
    .lt('sampled_at', new Date(Date.now() - keepMs).toISOString());
}

// The sum of one numeric meta field over today's (UTC) samples of a
// source, across every market: what a paid source has spent so far today.
export async function dailyLedger(source: string, metaKey: string, now = Date.now()): Promise<number> {
  const dayStart = new Date(now).toISOString().slice(0, 10) + 'T00:00:00.000Z';
  const { data, error } = await createAdminClient()
    .from('vi_samples')
    .select('meta')
    .eq('source', source)
    .gte('sampled_at', dayStart);
  if (error) {
    console.error(`[samples] ledger failed (${source}): ${error.message}`);
    return Number.POSITIVE_INFINITY; // unknown spend: treat as exhausted
  }
  let sum = 0;
  for (const row of (data ?? []) as { meta: Record<string, unknown> | null }[]) {
    const v = row.meta?.[metaKey];
    if (typeof v === 'number' && Number.isFinite(v)) sum += v;
  }
  return sum;
}
