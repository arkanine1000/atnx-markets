// Where creator handle resolutions are kept (supabase/017_market_handles).
// The resolver runs on its own: right after a person market's capture is
// scored, and in an hourly pass that re-checks each market weekly. An
// admin's decision (verify or reject, on the dashboard's Handles tab) is
// final and never overwritten by a later automatic run.
import { createAdminClient } from '@/lib/supabase/admin';
import { resolveYoutube, type Resolution } from './resolve';

const RECHECK_MS = 7 * 24 * 3600 * 1000;
const PASS_LIMIT = 8;
export const ADMIN_DECIDED = 'admin';

interface HandleRow {
  market_id: string;
  status: 'candidate' | 'verified' | 'rejected';
  platform_id: string | null;
  confidence: string | null;
  verified_at: string | null;
  checked_at: string;
}

async function existingRow(marketId: string): Promise<HandleRow | null> {
  const { data } = await createAdminClient()
    .from('market_handles')
    .select('market_id, status, platform_id, confidence, verified_at, checked_at')
    .eq('market_id', marketId)
    .eq('platform', 'youtube')
    .maybeSingle();
  return (data as HandleRow | null) ?? null;
}

// Stores a resolution unless an admin already decided. A channel that was
// already verified keeps its verified_at, so its score ramp is not reset.
export async function saveYoutubeResolution(marketId: string, r: Resolution): Promise<'saved' | 'kept'> {
  const prev = await existingRow(marketId);
  if (prev?.confidence === ADMIN_DECIDED) {
    await createAdminClient().from('market_handles').update({ checked_at: new Date().toISOString() }).eq('market_id', marketId).eq('platform', 'youtube');
    return 'kept';
  }
  const ch = r.best?.channel ?? null;
  const now = new Date().toISOString();
  const sameVerified = prev?.status === 'verified' && ch && prev.platform_id === ch.id;
  const row = {
    market_id: marketId,
    platform: 'youtube' as const,
    handle: ch?.handle ?? null,
    platform_id: ch?.id ?? null,
    status: r.status === 'none' ? ('candidate' as const) : r.status,
    review: r.review,
    confidence: r.reason,
    evidence: {
      candidates: r.candidates
        .slice()
        .sort((a, b) => (b.channel.subscribers ?? 0) - (a.channel.subscribers ?? 0))
        .slice(0, 6)
        .map((c) => ({ id: c.channel.id, handle: c.channel.handle, title: c.channel.title, subscribers: c.channel.subscribers, videos: c.channel.videos, evidence: c.evidence, name_match: c.nameMatch })),
    },
    audience: ch?.subscribers ?? null,
    verified_at: r.status === 'verified' ? (sameVerified ? prev!.verified_at : now) : null,
    checked_at: now,
  };
  const { error } = await createAdminClient().from('market_handles').upsert(row, { onConflict: 'market_id,platform' });
  if (error) throw new Error(`market_handles upsert: ${error.message}`);
  return 'saved';
}

export async function resolveAndSave(marketId: string, { allowSearch = false } = {}) {
  const db = createAdminClient();
  const { data: m, error } = await db.from('markets').select('entity_name, aliases, vi_components').eq('id', marketId).maybeSingle();
  if (error || !m) throw new Error(error?.message ?? 'market not found');
  const { data: caps } = await db.from('captures').select('source_url, ocr_text').eq('market_id', marketId).is('deleted_at', null);
  const wiki = (m.vi_components as Record<string, { meta?: { title?: string | null } }> | null)?.wikipedia?.meta?.title ?? null;
  const r = await resolveYoutube({ name: m.entity_name, aliases: (m.aliases as string[] | null) ?? [], wikipediaTitle: wiki, captures: caps ?? [], allowSearch });
  const saved = await saveYoutubeResolution(marketId, r);
  return { status: r.status, review: r.review, handle: r.best?.channel.handle ?? null, units: r.cost.units, saved };
}

// Whether a market has been looked at at all.
export async function hasYoutubeRow(marketId: string): Promise<boolean> {
  return (await existingRow(marketId)) !== null;
}

export interface ResolverPassSummary {
  checked: number;
  verified: number;
  review: number;
  units: number;
  errors: number;
}

// The hourly pass: person markets never checked, then those checked over a
// week ago; a few per run. Channel searches stay off (the verified
// channels in the first dry run all came from free evidence).
export async function runResolverPass(now = Date.now()): Promise<ResolverPassSummary> {
  const summary: ResolverPassSummary = { checked: 0, verified: 0, review: 0, units: 0, errors: 0 };
  const db = createAdminClient();
  const { data: people, error } = await db.from('markets').select('id, created_at').is('deleted_at', null).eq('entity_type', 'person');
  if (error) throw new Error(error.message);
  const { data: rows } = await db.from('market_handles').select('market_id, checked_at, confidence').eq('platform', 'youtube');
  const seen = new Map((rows ?? []).map((r) => [r.market_id as string, r as { checked_at: string; confidence: string | null }]));
  const due = (people ?? [])
    .filter((p) => {
      const r = seen.get(p.id);
      return !r || (r.confidence !== ADMIN_DECIDED && now - Date.parse(r.checked_at) > RECHECK_MS);
    })
    .sort((a, b) => Number(seen.has(a.id)) - Number(seen.has(b.id)) || (a.created_at < b.created_at ? 1 : -1))
    .slice(0, PASS_LIMIT);
  for (const p of due) {
    try {
      const r = await resolveAndSave(p.id);
      summary.checked++;
      summary.units += r.units;
      if (r.status === 'verified') summary.verified++;
      if (r.review) summary.review++;
    } catch (err) {
      summary.errors++;
      console.error('[creators] resolve failed', p.id, (err as Error).message);
    }
  }
  return summary;
}
