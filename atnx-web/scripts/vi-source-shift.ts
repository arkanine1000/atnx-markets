// What a new source would do to every live market, before it is on in
// production: reads the source now for each market it applies to (one
// actor run, real spend, samples written), then scores each market's
// stored breakdown with and without the new component under the current
// combine. Prints the rank correlation, the mean change, tier moves and
// a per-market table, and writes the same as Markdown.
//
//   npm run vi:source-shift -- tiktok_search docs/reports/vi-shift-tiktok-search-2026-10-04.md
//
// "Before" is the live breakdown as stored; "after" adds the new
// readings. Nothing else is refetched, so the difference is the source.
import { writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';
import { combine, summarizeAttention, viTier, type Components, type SourceComponent, type SourceName } from '../lib/vi/score';
import { fetchTiktokSearchSignal, prefetchTiktokSearch } from '../lib/vi/tiktok-search';
import { searchTerms, searchableAliases } from '../lib/vi/score';

const sources = (process.argv[2] ?? '').split(',').map((s) => s.trim()).filter(Boolean) as SourceName[];
const outPath = process.argv[3];
if (sources.length === 0) {
  console.error('usage: npm run vi:source-shift -- <source[,source]> [out.md]');
  process.exit(1);
}
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

interface Market { id: string; entity_name: string; entity_type: string | null; category: string | null; aliases: string[] | null; current_vi: number | null; vi_components: Components | null; vi_state: string | null }
const CATS: Partial<Record<SourceName, Set<string>>> = {
  tiktok_search: new Set(['memes', 'people', 'music', 'film_tv', 'gaming']),
};
const spearman = (a: number[], b: number[]): number => {
  const rank = (v: number[]) => { const idx = v.map((x, i) => [x, i] as const).sort((p, q) => q[0] - p[0]); const r = new Array<number>(v.length); idx.forEach(([, i], k) => (r[i] = k + 1)); return r; };
  const ra = rank(a), rb = rank(b), n = a.length;
  return n < 2 ? 1 : 1 - (6 * ra.reduce((acc, x, i) => acc + (x - rb[i]) ** 2, 0)) / (n * (n * n - 1));
};
const fmt = (v: number | null | undefined, d = 0) => (v === null || v === undefined ? '-' : v.toFixed(d));

async function readSource(name: SourceName, markets: Market[]): Promise<Map<string, SourceComponent>> {
  const out = new Map<string, SourceComponent>();
  const eligible = markets.filter((m) => CATS[name]?.has(m.category ?? ''));
  const termOf = (m: Market) => searchTerms(m.entity_name, searchableAliases(m.aliases ?? [], m.vi_components?.wikipedia?.meta), { wiki: m.vi_components?.wikipedia?.meta, entityType: m.entity_type ?? undefined, category: m.category ?? undefined, name: m.entity_name }).term;
  // Each source reads one run per call and caps it, so a round reads
  // what fits and the next round reads the rest (a market already read
  // is handed its reading as stored and is no longer due).
  const rounds = 8;
  if (name === 'tiktok_search') {
    console.error(`tiktok_search: ${eligible.length} markets`);
    // A market is done once it was searched (a pass hands the markets
    // it did not search an empty re-read, which is not a reading).
    const done = (id: string) => typeof out.get(id)?.meta?.searched_at === 'string';
    for (let i = 0; i < rounds; i++) {
      const reqs = eligible.map((m) => ({ marketId: m.id, term: termOf(m), stored: out.get(m.id) ?? null }));
      if (prefetchTiktokSearch(reqs) === 0) break;
      for (const r of reqs) { if (done(r.marketId)) continue; const c = await fetchTiktokSearchSignal(r); if (c) out.set(r.marketId, c); }
      console.error(`  round ${i + 1}: ${eligible.filter((m) => done(m.id)).length} of ${eligible.length} searched`);
      if (eligible.every((m) => done(m.id))) break;
    }
  } else {
    throw new Error(`no reader for ${name}`);
  }
  return out;
}

async function main() {
  const { data, error } = await s.from('markets').select('id, entity_name, entity_type, category, aliases, current_vi, vi_components, vi_state').is('deleted_at', null).eq('vi_state', 'live').order('current_vi', { ascending: false });
  if (error) throw error;
  const markets = (data ?? []) as Market[];
  const readings = new Map<SourceName, Map<string, SourceComponent>>();
  for (const name of sources) readings.set(name, await readSource(name, markets));

  const rows = markets.map((m) => {
    const before = m.vi_components ?? {};
    const after: Components = { ...before };
    const got: Partial<Record<SourceName, SourceComponent>> = {};
    for (const name of sources) { const c = readings.get(name)?.get(m.id); if (c && c.level !== null) { after[name] = c; got[name] = c; } }
    const b = combine(before)?.score ?? 0;
    const a = combine(after)?.score ?? 0;
    const sh = summarizeAttention(after)?.shares ?? {};
    return { m, b, a, got, share: sources.map((n) => sh[n] ?? 0) };
  });
  const touched = rows.filter((r) => Object.keys(r.got).length > 0);
  const lines: string[] = [];
  const say = (l = '') => { lines.push(l); console.log(l); };
  say(`# VI shift: ${sources.join(' + ')}, ${new Date().toISOString().slice(0, 16)}Z`);
  say();
  say(`${markets.length} live markets; ${touched.length} got a reading from the new source${sources.length > 1 ? 's' : ''}.`);
  const b = rows.map((r) => r.b), a = rows.map((r) => r.a);
  const d = rows.map((r) => r.a - r.b);
  say(`Spearman before vs after: ${spearman(b, a).toFixed(4)}. Mean change ${(d.reduce((x, y) => x + y, 0) / rows.length).toFixed(1)}, over the touched markets ${(touched.reduce((x, r) => x + r.a - r.b, 0) / Math.max(1, touched.length)).toFixed(1)}. |change| >= 50: ${d.filter((x) => Math.abs(x) >= 50).length}. Tier moves: ${rows.filter((r) => viTier(r.b).label !== viTier(r.a).label).length}.`);
  for (const name of sources) {
    const cs = [...(readings.get(name)?.values() ?? [])];
    const known = cs.filter((c) => c.level !== null);
    say(`${name}: ${cs.length} read, ${known.length} with a level, ${known.filter((c) => (c.level ?? 0) > 0).length} above zero, ${known.filter((c) => c.momentum !== null).length} with a momentum.`);
  }
  say();
  say(`| before | after | change | ${sources.map((n) => `${n} level`).join(' | ')} | ${sources.map((n) => `${n} share`).join(' | ')} | reading | market |`);
  say(`|---:|---:|---:|${sources.map(() => '---:').join('|')}|${sources.map(() => '---:').join('|')}|---|---|`);
  for (const r of [...rows].sort((p, q) => Math.abs(q.a - q.b) - Math.abs(p.a - p.b))) {
    const reading = sources.map((n) => { const c = r.got[n]; if (!c) return ''; const m = c.meta ?? {}; return `${m.views_per_day ?? '-'} views/d on ${m.posts_read} of ${m.set_size}`; }).filter(Boolean).join('; ');
    const tier = viTier(r.b).label !== viTier(r.a).label ? ` (${viTier(r.b).label} → ${viTier(r.a).label})` : '';
    say(`| ${r.b} | ${r.a} | ${r.a - r.b > 0 ? '+' : ''}${r.a - r.b} | ${sources.map((n) => fmt(r.got[n]?.level ?? null)).join(' | ')} | ${r.share.map((x) => `${(x * 100).toFixed(0)}%`).join(' | ')} | ${reading} | ${r.m.entity_name}${tier} |`);
  }
  if (outPath) { writeFileSync(outPath, lines.join('\n') + '\n'); console.error(`written ${outPath}`); }
}
main().catch((e) => { console.error(e); process.exit(1); });
