// Read-only: what the Trends topic switch did to each market, without
// waiting for the smoothing. "Before" is each market's last
// vi_component_history snapshot before the boundary (the hourly pass
// before topics landed), "after" its live breakdown; both are scored
// with the current combine. Prints the Trends ratio and share before and
// after, the raw score change, the rank correlation and the tier moves.
//
//   npm run vi:topic-shift -- 2026-09-30T14:09:00Z
import { createClient } from '@supabase/supabase-js';
import { combine, viTier, summarizeAttention, type Components } from '../lib/vi/score';

const boundary = process.argv[2];
if (!boundary || !Number.isFinite(Date.parse(boundary))) { console.error('usage: npm run vi:topic-shift -- <isoBoundary>'); process.exit(1); }
const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });

function spearman(a: number[], b: number[]): number {
  const rank = (v: number[]) => { const idx = v.map((x, i) => [x, i] as const).sort((p, q) => q[0] - p[0]); const r = new Array<number>(v.length); idx.forEach(([, i], k) => (r[i] = k + 1)); return r; };
  const ra = rank(a), rb = rank(b), n = a.length;
  return 1 - (6 * ra.reduce((acc, x, i) => acc + (x - rb[i]) ** 2, 0)) / (n * (n * n - 1));
}

async function main() {
  const { data: ms } = await s.from('markets').select('id, entity_name, current_vi, vi_components').is('deleted_at', null).order('current_vi', { ascending: false });
  const { data: snaps } = await s.from('vi_component_history').select('market_id, components, raw_vi, recorded_at').lt('recorded_at', boundary).gte('recorded_at', new Date(Date.parse(boundary) - 3 * 3600e3).toISOString()).order('recorded_at', { ascending: false });
  const before = new Map<string, Components>();
  for (const r of snaps ?? []) if (!before.has(r.market_id)) before.set(r.market_id, r.components as Components);
  const rows: { name: string; b: number; a: number; rb: number | null; ra: number | null; sb: number; sa: number; kw: string; tb: string; ta: string }[] = [];
  for (const m of ms ?? []) {
    const cb = before.get(m.id); if (!cb) continue;
    const ca = m.vi_components as Components;
    const b = combine(cb)?.score ?? 0, a = combine(ca)?.score ?? 0;
    const shb = summarizeAttention(cb)?.shares?.trends ?? 0, sha = summarizeAttention(ca)?.shares?.trends ?? 0;
    const tb = cb.trends?.meta ?? {}, ta = ca.trends?.meta ?? {};
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    rows.push({ name: m.entity_name, b, a, rb: num(tb.ratio_to_benchmark), ra: num(ta.ratio_to_benchmark), sb: shb, sa: sha, kw: String(ta.keyword ?? '-'), tb: viTier(b).label, ta: viTier(a).label });
  }
  const topics = rows.filter((r) => /^\/[mg]\//.test(r.kw));
  console.log(`boundary ${boundary}: ${rows.length} markets with a snapshot before it; ${topics.length} now read Trends by topic`);
  console.log(`Spearman raw before vs after: ${spearman(rows.map((r) => r.b), rows.map((r) => r.a)).toFixed(4)}; tier moves ${rows.filter((r) => r.tb !== r.ta).length}; |Δ| ≥ 50: ${rows.filter((r) => Math.abs(r.a - r.b) >= 50).length}; mean Δ ${(rows.reduce((x, r) => x + r.a - r.b, 0) / rows.length).toFixed(1)}`);
  console.log('\nraw before → after    Δ   trends ratio before → after   share b → a   keyword                    market');
  for (const r of rows.sort((p, q) => Math.abs(q.a - q.b) - Math.abs(p.a - p.b))) {
    console.log(`${String(r.b).padStart(4)} → ${String(r.a).padStart(4)}  ${String(r.a - r.b).padStart(5)}   ${String(r.rb ?? '-').padStart(8)} → ${String(r.ra ?? '-').padEnd(8)}   ${(r.sb * 100).toFixed(0).padStart(3)}% → ${(r.sa * 100).toFixed(0).padStart(3)}%   ${r.kw.slice(0, 24).padEnd(24)}   ${r.name}${r.tb !== r.ta ? ` (${r.tb} → ${r.ta})` : ''}`);
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
