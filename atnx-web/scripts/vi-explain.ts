// One market's VI in plain words, from the terminal: what the admin's VI
// tab shows (lib/vi/explain.ts through lib/vi/diagnostics.ts).
//
//   npm run vi:explain -- "Halloween"          # the breakdown and the last day's moves
//   npm run vi:explain -- "Halloween" 7d
//   npm run vi:explain -- --health             # sources, spend and cron health
//   npm run vi:explain                         # the market list with flags
import { createClient } from '@supabase/supabase-js';
import { loadViHealth, loadViMarket, loadViOverview } from '../lib/vi/diagnostics';

async function main() {
  const [name, window = '24h'] = process.argv.slice(2);
  if (name === '--health') {
    const h = await loadViHealth();
    for (const s of h.cron.sentences) console.log(s);
    console.log('spend today:', h.spend.map((s) => `${s.label} $${s.usd.toFixed(3)} (${s.units.map((u) => `${u.n} ${u.label}`).join(', ')})`).join(' | '));
    console.log('use:', JSON.stringify(h.use));
    console.log('last samples:', Object.entries(h.lastSampleAt).map(([k, v]) => `${k} ${v ?? '-'}`).join(' | '));
    const bad = h.cron.hours.filter((x) => !x.ok);
    console.log(bad.length ? `hours not ok: ${bad.map((x) => `${x.hour.slice(11, 16)} fast ${x.fastSlots} slow ${x.slowMarkets}`).join('; ')}` : 'every hour ok');
    return;
  }
  if (!name) {
    const o = await loadViOverview();
    console.log(`${o.rows.length} markets, ${o.live} live; tiers ${JSON.stringify(o.tiers)}`);
    for (const c of o.coverage) console.log(`  ${c.label.padEnd(16)} answering ${String(c.answering).padStart(3)}  seeing ${String(c.seeing).padStart(3)}  unknown ${String(c.unknown).padStart(3)}  not asked ${String(c.notAsked).padStart(3)}  stale ${c.stale}  late ${c.late}`);
    console.log('\n  VI  tier          top source           ans   flags                    market');
    for (const r of o.rows) console.log(`${String(r.vi).padStart(4)}  ${r.tier.padEnd(12)}  ${(r.topLabel ? `${r.topLabel} ${Math.round((r.topShare ?? 0) * 100)}%` : '-').padEnd(20)} ${r.answering}/${r.asked}  ${r.flags.join(',').padEnd(24)} ${r.name}`);
    return;
  }
  const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
  const { data } = await s.from('markets').select('id, entity_name').is('deleted_at', null).ilike('entity_name', `%${name}%`).order('current_vi', { ascending: false }).limit(1).maybeSingle();
  if (!data) throw new Error(`no market matches "${name}"`);
  const d = await loadViMarket(data.id, window === '7d' ? '7d' : '24h');
  if (!d) throw new Error('market not found');
  console.log(`${d.market.name}  VI ${Math.round(d.market.currentVi ?? 0)}  ${d.explanation.flags.join(', ') || 'no flags'}  (${d.snapshots} snapshots)`);
  for (const line of d.explanation.composite.sentences) console.log(line);
  console.log();
  for (const x of d.explanation.sources) console.log(x.sentence);
  if (d.explanation.notAsked.length) console.log(`Not asked: ${d.explanation.notAsked.map((n) => `${n.label} (${n.why})`).join('; ')}.`);
  console.log();
  for (const line of d.moves.headline) console.log(line);
  if (d.moves.note) console.log(d.moves.note);
  for (const m of d.moves.moves) console.log(`${m.from.slice(0, 16)} → ${m.to.slice(11, 16)}  ${m.sentence}`);
  if (d.moves.gaps.length) console.log(`Gaps: ${d.moves.gaps.map((g) => `${g.from.slice(0, 16)} → ${g.to.slice(11, 16)} (${g.hours} h)`).join('; ')}`);
}
main().catch((e) => { console.error(e); process.exit(1); });
