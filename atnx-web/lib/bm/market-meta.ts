import { createAdminClient } from '@/lib/supabase/admin';

// Name, picture and VI for a set of atnx markets, for the registry views
// (portfolio, the bounded-markets API). The picture follows the cards:
// the curated thumbnail when the image job found one, else the newest
// live capture, which every market has from the day it was created.

export interface MarketMeta {
  name: string;
  thumb: string | null;
  vi: number;
}

export async function loadMarketMeta(ids: string[]): Promise<Map<string, MarketMeta>> {
  const meta = new Map<string, MarketMeta>();
  if (ids.length === 0) return meta;
  const db = createAdminClient();
  const [markets, captures] = await Promise.all([
    db.from('markets').select('id, entity_name, thumbnail_url, current_vi').in('id', ids),
    db
      .from('captures')
      .select('market_id, image_url, created_at')
      .in('market_id', ids)
      .is('deleted_at', null)
      .not('image_url', 'is', null)
      .order('created_at', { ascending: false }),
  ]);
  if (markets.error) throw markets.error;
  if (captures.error) throw captures.error;
  const newest = new Map<string, string>();
  for (const c of captures.data ?? []) {
    if (c.market_id && c.image_url && !newest.has(c.market_id)) newest.set(c.market_id, c.image_url);
  }
  for (const m of markets.data ?? []) {
    meta.set(m.id, { name: m.entity_name, thumb: m.thumbnail_url ?? newest.get(m.id) ?? null, vi: Number(m.current_vi ?? 0) });
  }
  return meta;
}
