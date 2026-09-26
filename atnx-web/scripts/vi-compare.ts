// Read-only comparison of every market's VI across a calculation change.
// "Before" is the last vi_history point before the boundary; "after" is
// the smoothed score at boundary + afterHours and the median raw score
// over (boundary + 1 h, boundary + afterHours]. The 2 h smoothing means
// +3 h shows 65% of a step and +6 h 87.5%.
//
//   npm run vi:compare -- 2026-09-27T12:00:00Z        # +3 h
//   npm run vi:compare -- 2026-09-27T12:00:00Z 6      # +6 h
//
// Also prints each market's top source and share under the current
// combine, the anchors' targets, the largest one-hour moves since the
// boundary, and the markets now at 0 (markets_liquidate_on_vi fires on
// every current_vi change). Writes nothing.
import { createClient } from '@supabase/supabase-js';
import { attention, median, viTier, type Components } from '../lib/vi/score';
import { ANCHORS, REPORTED } from './vi-anchors';

const H = 3600e3;
const boundaryArg = process.argv[2];
if (!boundaryArg || !Number.isFinite(Date.parse(boundaryArg))) {
  console.error('usage: npm run vi:compare -- <isoBoundary> [afterHours=3]');
  process.exit(1);
}
const T = Date.parse(boundaryArg);
const AFTER_H = Number(process.argv[3] ?? 3);
const END = T + AFTER_H * H;

interface Point {
  t: number;
  vi: number;
  raw: number | null;
}

function spearman(a: number[], b: number[]): number {
  const rank = (xs: number[]) => {
    const idx = xs.map((v, i) => [v, i] as const).sort((p, q) => p[0] - q[0]);
    const r = new Array<number>(xs.length);
    for (let i = 0; i < idx.length; ) {
      let j = i;
      while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
      const avg = (i + j) / 2 + 1;
      for (let k = i; k <= j; k++) r[idx[k][1]] = avg;
      i = j + 1;
    }
    return r;
  };
  const ra = rank(a);
  const rb = rank(b);
  const n = a.length;
  const ma = ra.reduce((s, x) => s + x, 0) / n;
  const mb = rb.reduce((s, x) => s + x, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

(async () => {
  const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: markets, error } = await s.from('markets').select('id, entity_name, category, current_vi, vi_components').is('deleted_at', null).order('entity_name');
  if (error) throw error;

  const since = new Date(T - 24 * H).toISOString();
  const until = new Date(END + H).toISOString();
  const hist: { market_id: string; vi: number; raw_vi: number | null; recorded_at: string }[] = [];
  for (let from = 0; ; from += 1000) {
    const { data, error } = await s.from('vi_history').select('market_id, vi, raw_vi, recorded_at').gte('recorded_at', since).lte('recorded_at', until).order('recorded_at').order('id').range(from, from + 999);
    if (error) throw error;
    hist.push(...(data ?? []));
    if ((data ?? []).length < 1000) break;
  }
  const by = new Map<string, Point[]>();
  for (const r of hist) {
    if (!by.has(r.market_id)) by.set(r.market_id, []);
    by.get(r.market_id)!.push({ t: Date.parse(r.recorded_at), vi: Number(r.vi), raw: r.raw_vi === null ? null : Number(r.raw_vi) });
  }

  interface Row {
    name: string;
    cat: string | null;
    viBefore: number | null;
    rawBefore: number | null;
    viAfter: number | null;
    rawAfter: number | null;
    top: string;
    topShare: number;
    seeing: number;
    flags: string[];
  }
  const rows: Row[] = [];
  for (const m of markets ?? []) {
    const pts = by.get(m.id) ?? [];
    const before = pts.filter((p) => p.t < T).at(-1) ?? null;
    const afterPts = pts.filter((p) => p.t >= T && p.t <= END);
    const afterVi = afterPts.at(-1) ?? null;
    const rawWindow = afterPts.filter((p) => p.t > T + H && p.raw !== null).map((p) => p.raw as number);
    const at = attention((m.vi_components ?? {}) as Components);
    const seeing = Object.values(at.terms).filter((t) => (t ?? 0) > 0).length;
    const row: Row = {
      name: m.entity_name,
      cat: m.category,
      viBefore: before?.vi ?? null,
      rawBefore: before?.raw ?? null,
      viAfter: afterVi?.vi ?? null,
      rawAfter: rawWindow.length ? median(rawWindow) : null,
      top: at.topSource ?? '-',
      topShare: at.topShare,
      seeing,
      flags: [],
    };
    if (row.viAfter !== null && Math.round(row.viAfter) === 0) row.flags.push('ZERO');
    if (at.topShare > 0.7 && seeing >= 3) row.flags.push('TOP>70%');
    if (row.viBefore !== null && row.viAfter !== null) {
      if (viTier(row.viBefore).label !== viTier(row.viAfter).label) row.flags.push('TIER');
      if (Math.abs(row.viAfter - row.viBefore) > 200) row.flags.push('|Δ|>200');
    }
    rows.push(row);
  }
  rows.sort((a, b) => (b.viAfter ?? -1) - (a.viAfter ?? -1));

  const f = (x: number | null, w = 6) => String(x === null ? '-' : Math.round(x)).padStart(w);
  console.log(`Boundary ${new Date(T).toISOString()}  after +${AFTER_H} h (${new Date(END).toISOString()})  markets ${rows.length}  history rows ${hist.length}\n`);
  console.log('market                          cat       raw_b   vi_b  raw_a   vi_a    Δvi  tier before → after      anchor  Δanchor  top source       seeing  flags');
  for (const r of rows) {
    const target = ANCHORS[r.name] ?? REPORTED[r.name];
    const tgt = target === undefined ? '' : REPORTED[r.name] !== undefined ? `(${target})` : String(target);
    const dAnchor = target === undefined || r.viAfter === null ? '' : String(Math.round(r.viAfter - target));
    const tiers = r.viBefore === null || r.viAfter === null ? '-' : `${viTier(r.viBefore).label} → ${viTier(r.viAfter).label}`;
    const d = r.viBefore === null || r.viAfter === null ? null : r.viAfter - r.viBefore;
    console.log(
      `${r.name.slice(0, 30).padEnd(30)}  ${(r.cat ?? '-').padEnd(8)} ${f(r.rawBefore)} ${f(r.viBefore)} ${f(r.rawAfter)} ${f(r.viAfter)} ${f(d)}  ${tiers.padEnd(25)} ${tgt.padStart(6)} ${dAnchor.padStart(8)}  ${`${r.top} ${Math.round(r.topShare * 100)}%`.padEnd(16)} ${String(r.seeing).padStart(6)}  ${r.flags.join(' ')}`
    );
  }

  const withAnchor = rows.filter((r) => ANCHORS[r.name] !== undefined && r.viBefore !== null && r.viAfter !== null);
  const rmse = (pick: (r: Row) => number) => Math.sqrt(withAnchor.reduce((s, r) => s + (pick(r) - ANCHORS[r.name]) ** 2, 0) / Math.max(1, withAnchor.length));
  console.log(`\nAnchors (${withAnchor.length}): RMSE before ${rmse((r) => r.viBefore!).toFixed(0)}, after ${rmse((r) => r.viAfter!).toFixed(0)}`);
  const paired = rows.filter((r) => r.viBefore !== null && r.viAfter !== null);
  console.log(`Rank correlation old vs new (Spearman, ${paired.length} markets): ${spearman(paired.map((r) => r.viBefore!), paired.map((r) => r.viAfter!)).toFixed(3)}`);

  // Largest one-hour moves since the boundary, smoothed and raw.
  const moves: { name: string; at: string; dVi: number; dRaw: number }[] = [];
  for (const m of markets ?? []) {
    const p = (by.get(m.id) ?? []).filter((x) => x.t >= T - H);
    for (let i = 0; i < p.length; i++) {
      if (p[i].t < T) continue;
      let best = 0, bestRaw = 0;
      for (let j = i - 1; j >= 0 && p[i].t - p[j].t <= H; j--) {
        best = Math.max(best, Math.abs(p[i].vi - p[j].vi));
        if (p[i].raw !== null && p[j].raw !== null) bestRaw = Math.max(bestRaw, Math.abs(p[i].raw! - p[j].raw!));
      }
      if (best > 0 || bestRaw > 0) moves.push({ name: m.entity_name, at: new Date(p[i].t).toISOString().slice(5, 16), dVi: best, dRaw: bestRaw });
    }
  }
  const top = new Map<string, { at: string; dVi: number; dRaw: number }>();
  for (const mv of moves) {
    const cur = top.get(mv.name);
    if (!cur || Math.max(mv.dVi, mv.dRaw) > Math.max(cur.dVi, cur.dRaw)) top.set(mv.name, mv);
  }
  console.log('\nLargest one-hour moves since the boundary:');
  for (const [name, mv] of [...top.entries()].sort((a, b) => Math.max(b[1].dVi, b[1].dRaw) - Math.max(a[1].dVi, a[1].dRaw)).slice(0, 12)) {
    console.log(`  ${name.padEnd(30)} ${mv.at}  dVi1h ${mv.dVi.toFixed(0).padStart(4)}  dRaw1h ${mv.dRaw.toFixed(0).padStart(4)}`);
  }

  const zero = rows.filter((r) => r.flags.includes('ZERO')).map((r) => r.name);
  console.log(`\n${zero.length} markets at 0 after the boundary: ${zero.join(', ')}`);
  const heavy = rows.filter((r) => r.flags.includes('TOP>70%')).map((r) => `${r.name} (${r.top} ${Math.round(r.topShare * 100)}%)`);
  console.log(`${heavy.length} markets with one source above 70% (3+ seeing): ${heavy.join('; ')}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
