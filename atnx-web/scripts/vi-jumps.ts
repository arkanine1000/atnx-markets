// Lists every move larger than a threshold within one hour, smoothed and
// raw, over the last 7 days of vi_history, with each market's first
// point and peak. Steps cluster at calculation changes (see the VI
// calculation changelog) and at slow-refresh writes.
//
//   npm run vi:jumps            # threshold 200
//   npm run vi:jumps -- 100
//
// Writes nothing.
import { createClient } from '@supabase/supabase-js';

(async () => {

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const TH = Number(process.argv[2] ?? 200);
const { data: ms } = await s.from('markets').select('id, entity_name').is('deleted_at', null);
const name = new Map((ms ?? []).map((m) => [m.id as string, m.entity_name as string]));
const since = new Date(Date.now() - 7 * 864e5).toISOString();
const rows: { market_id: string; vi: number; raw_vi: number | null; recorded_at: string }[] = [];
for (let f = 0; ; f += 1000) {
  const { data, error } = await s.from('vi_history').select('market_id, vi, raw_vi, recorded_at').gte('recorded_at', since).order('recorded_at').order('id').range(f, f + 999);
  if (error) throw error;
  rows.push(...(data ?? []));
  if ((data ?? []).length < 1000) break;
}
interface P { t: number; at: string; vi: number; raw: number | null }
const by = new Map<string, P[]>();
for (const r of rows) {
  if (!name.has(r.market_id)) continue;
  if (!by.has(r.market_id)) by.set(r.market_id, []);
  by.get(r.market_id)!.push({ t: Date.parse(r.recorded_at), at: r.recorded_at.slice(5, 16), vi: +r.vi, raw: r.raw_vi == null ? null : +r.raw_vi });
}
const hourBuckets: Record<string, number> = {};
for (const [id, p] of by) {
  const peak = p.reduce((a, b) => (b.vi > a.vi ? b : a));
  const ev: string[] = [];
  for (let i = 0; i < p.length; i++) {
    let best = 0, bestRaw = 0;
    for (let j = i - 1; j >= 0 && p[i].t - p[j].t <= 3600e3; j--) {
      best = Math.max(best, Math.abs(p[i].vi - p[j].vi));
      const a = p[i].raw, b = p[j].raw;
      if (a != null && b != null) bestRaw = Math.max(bestRaw, Math.abs(a - b));
    }
    if (best > TH || bestRaw > TH) {
      ev.push(`${p[i].at} vi=${p[i].vi} raw=${p[i].raw} (dVi1h=${best.toFixed(0)} dRaw1h=${bestRaw.toFixed(0)})`);
      hourBuckets[p[i].at.slice(0, 8)] = (hourBuckets[p[i].at.slice(0, 8)] ?? 0) + 1;
    }
  }
  const first = p[0];
  const shown = [ev[0], ev[ev.length - 1]].filter((v, i, a) => v && a.indexOf(v) === i);
  console.log(`${name.get(id)} | first7d=${first.at} vi=${first.vi} raw=${first.raw} | peak=${peak.vi}@${peak.at} | events=${ev.length}${shown.length ? '\n    ' + shown.join('\n    ') : ''}`);
}
console.log('events by hour', hourBuckets);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
