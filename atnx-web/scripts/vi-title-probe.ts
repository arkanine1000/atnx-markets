// Read-only probe of the YouTube title relevance filter (lib/vi/relevance.ts)
// on live markets: fetches the titles of each market's stored video set and
// prints which the model keeps and which it drops, with their views.
//
//   npm run vi:titles -- "Trollface" "Verity (Minecraft ARG)"   # named markets
//   npm run vi:titles                                          # every live market with a set
//
// Costs one videos.list unit and one gateway call per market. Writes nothing.
import { createClient } from '@supabase/supabase-js';
import { filterRelevantTitles } from '../lib/vi/relevance';
import type { Components } from '../lib/vi/score';

const API = 'https://www.googleapis.com/youtube/v3';

async function titles(ids: string[]): Promise<{ id: string; title: string; channel: string; views: number }[]> {
  const params = new URLSearchParams({ part: 'snippet,statistics', id: ids.slice(0, 50).join(','), key: process.env.YOUTUBE_API_KEY ?? '' });
  const res = await fetch(`${API}/videos?${params}`, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`videos.list ${res.status}`);
  const body = (await res.json()) as { items?: { id: string; snippet?: { title?: string; channelTitle?: string }; statistics?: { viewCount?: string } }[] };
  return (body.items ?? []).map((v) => ({ id: v.id, title: v.snippet?.title ?? '', channel: v.snippet?.channelTitle ?? '', views: Number(v.statistics?.viewCount ?? 0) }));
}

(async () => {
  const names = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  let q = s.from('markets').select('entity_name, entity_type, category, aliases, vi_components').is('deleted_at', null).order('entity_name');
  if (names.length) q = q.in('entity_name', names);
  const { data, error } = await q;
  if (error) throw error;
  for (const m of data ?? []) {
    const yt = ((m.vi_components ?? {}) as Components).youtube;
    const ids = typeof yt?.meta?.videos === 'string' && yt.meta.videos ? yt.meta.videos.split(',') : [];
    if (ids.length === 0) {
      if (names.length) console.log(`\n${m.entity_name}: no stored video set`);
      continue;
    }
    const vids = await titles(ids);
    const verdict = await filterRelevantTitles({ name: m.entity_name, aliases: (m.aliases as string[] | null) ?? [], entityType: m.entity_type, category: m.category }, vids);
    const kept = new Set(verdict.keep);
    const sum = (f: (v: { id: string }) => boolean) => vids.filter(f).reduce((a, v) => a + v.views, 0);
    console.log(`\n${m.entity_name} [${m.entity_type}/${m.category}] status=${verdict.status} kept ${verdict.keep.length}/${vids.length}  views kept ${sum((v) => kept.has(v.id)).toLocaleString()} / dropped ${sum((v) => !kept.has(v.id)).toLocaleString()} (stored title_filter=${yt?.meta?.title_filter ?? '-'})`);
    for (const v of [...vids].sort((a, b) => b.views - a.views)) console.log(`  ${kept.has(v.id) ? 'KEEP' : 'DROP'} ${String(v.views).padStart(11)}  ${v.title}  [${v.channel}]`);
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
