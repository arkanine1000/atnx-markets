// What the board would read with the X post filter on: for each market,
// the counterfactual impressions the shadow recorded on every read in
// the last day (views of the kept posts scaled by the kept rate), the day's
// median as the live path takes it, and the score that follows with the
// current calibration. Own-account reach still wins where it is larger.
//
//   npm run jev:simulate-x -- [--hours=24]
import { createClient } from '@supabase/supabase-js';
import { combine, viTier, median, type Components } from '../lib/vi/score';
import { xImpressionsPerHour } from '../lib/vi/x';

const args = new Map(process.argv.slice(2).map((a) => { const m = a.match(/^--([^=]+)(?:=(.*))?$/); return m ? [m[1], m[2] ?? '1'] : [a, '1']; }));
const HOURS = Number(args.get('hours') ?? 24);

function spearman(a: number[], b: number[]): number {
  const rank = (v: number[]) => { const idx = v.map((x, i) => [x, i] as const).sort((p, q) => q[0] - p[0]); const r = new Array(v.length); idx.forEach(([, i], k) => (r[i] = k + 1)); return r as number[]; };
  const ra = rank(a), rb = rank(b); const n = a.length;
  const d2 = ra.reduce((s, x, i) => s + (x - rb[i]) ** 2, 0);
  return 1 - (6 * d2) / (n * (n * n - 1));
}

async function main() {
  const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data: ms } = await s.from('markets').select('id, entity_name, current_vi, vi_components').is('deleted_at', null).order('current_vi', { ascending: false });
  const since = new Date(Date.now() - HOURS * 3600e3).toISOString();
  const { data: rows } = await s.from('vi_samples').select('market_id, meta, sampled_at').eq('source', 'x_tweet_shadow').gte('sampled_at', since);
  const perMarket = new Map<string, { live: number[]; cf: number[]; posts: number; kept: number }>();
  for (const r of rows ?? []) {
    const m = (r.meta ?? {}) as Record<string, number>;
    const e = perMarket.get(r.market_id) ?? { live: [], cf: [], posts: 0, kept: 0 };
    e.live.push(xImpressionsPerHour(Number(m.views_all), Number(m.tweets), Number(m.rate)));
    e.cf.push(xImpressionsPerHour(Number(m.views_kept), Number(m.keep), Number(m.rate_jev)));
    e.posts += Number(m.tweets); e.kept += Number(m.keep);
    perMarket.set(r.market_id, e);
  }
  const before: number[] = [], after: number[] = [];
  const lines: string[] = [];
  let tierChanges = 0;
  for (const m of ms ?? []) {
    const c = (m.vi_components ?? {}) as Components;
    const b = combine(c);
    const e = perMarket.get(m.id);
    let a = b;
    if (e && c.x?.meta && e.cf.length) {
      const cf = Math.round(median(e.cf));
      const c2: Components = { ...c, x: { ...c.x, meta: { ...c.x.meta, views_per_h: cf, views_per_h_read: cf, impressions_24h: cf * 24 } } };
      a = combine(c2);
    }
    if (!b || !a) continue;
    before.push(b.score); after.push(a.score);
    const tb = viTier(b.score).label, ta = viTier(a.score).label;
    if (tb !== ta) tierChanges++;
    if (e) lines.push(`${String(b.score).padStart(4)} → ${String(a.score).padStart(4)}  ${String(a.score - b.score).padStart(5)}  x talk ${String(Math.round(median(e.live))).padStart(7)} → ${String(Math.round(median(e.cf))).padStart(7)} /h  kept ${String(e.kept).padStart(4)}/${String(e.posts).padEnd(4)} ${tb !== ta ? `${tb} → ${ta}` : ''}  ${m.entity_name}`);
  }
  console.log(`X filter simulation over the last ${HOURS} h: ${perMarket.size} markets with shadow reads, ${before.length} scored`);
  console.log(`Spearman before vs after: ${spearman(before, after).toFixed(4)}; tier changes: ${tierChanges}; moves ≥ 20: ${before.filter((b, i) => Math.abs(after[i] - b) >= 20).length}`);
  console.log('\nbefore → after   Δ   x talk impressions/h (live → filtered)   kept posts         market');
  for (const l of lines.sort((p, q) => Math.abs(Number(q.slice(13, 18))) - Math.abs(Number(p.slice(13, 18))))) console.log(l);
}
main().catch((e) => { console.error(e); process.exit(1); });
