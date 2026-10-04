// What a refresh run did: per-source coverage (markets with a known
// reading, seeing attention, refreshed since the cutoff), the tier
// spread, GDELT health, the X and TikTok spend read from vi_samples, and
// the top and notable markets with their breakdowns.
//
//   npm run vi:report                       # since the last :07 slow run
//   npm run vi:report -- 2026-09-24T14:07Z  # since a given time
//
// Writes nothing.
import { createClient } from '@supabase/supabase-js';
import { viTier, type Components, type SourceComponent } from '../lib/vi/score';
import { USD_PER_TWEET, USD_PER_REQUEST_MIN } from '../lib/vi/x';
import { usdPerHashtag } from '../lib/vi/tiktok';
import { USD_PER_POST_READ, usdPerSearchResult } from '../lib/vi/tiktok-search';
import { usdPerRedditResult } from '../lib/vi/reddit';
import { usdPerInstagramResult } from '../lib/vi/instagram';

(async () => {

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const lastSlow = () => {
  const d = new Date();
  d.setUTCMinutes(7, 0, 0);
  if (d.getTime() > Date.now()) d.setUTCHours(d.getUTCHours() - 1);
  return d.toISOString();
};
const since = process.argv[2] ? new Date(process.argv[2]).toISOString() : lastSlow();

const { data } = await s.from('markets').select('id, entity_name, current_vi, vi_components, vi_last_updated').is('deleted_at', null).order('current_vi', { ascending: false });
const rows = (data ?? []) as unknown as { id: string; entity_name: string; current_vi: number | null; vi_components: Components | null; vi_last_updated: string | null }[];
const age = (iso?: string | null) => (iso ? Math.round((Date.now() - Date.parse(iso)) / 60000) : null);
const cov: Record<string, { known: number; seeing: number; fresh: number }> = {};
const tiers: Record<string, number> = {};
let zeroEverywhere = 0, gdeltUnknown = 0, gdeltMom0 = 0;
for (const m of rows) {
  const c = (m.vi_components ?? {}) as Record<string, SourceComponent | undefined>;
  const tier = viTier(Number(m.current_vi ?? 0)).label;
  tiers[tier] = (tiers[tier] ?? 0) + 1;
  let any = false;
  for (const [name, comp] of Object.entries(c)) {
    if (!comp) continue;
    cov[name] ??= { known: 0, seeing: 0, fresh: 0 };
    if (comp.level !== null) { cov[name].known++; if (comp.level > 0) { cov[name].seeing++; any = true; } }
    if (comp.fetchedAt > since) cov[name].fresh++;
  }
  if (!any) zeroEverywhere++;
  if (!c.gdelt || c.gdelt.level === null) gdeltUnknown++;
  if (c.gdelt?.momentum === 0) gdeltMom0++;
}
console.log('since', since, '| markets', rows.length, '| tiers', JSON.stringify(tiers));
console.log('zero everywhere', zeroEverywhere, '| gdelt unknown', gdeltUnknown, '| gdelt momentum==0', gdeltMom0);
console.log('coverage (known / seeing / fresh):');
for (const [n, v] of Object.entries(cov).sort()) console.log('  ', n.padEnd(10), v.known, v.seeing, v.fresh);

const { data: xs } = await s.from('vi_samples').select('meta').eq('source', 'x').gte('sampled_at', since);
const xr = (xs ?? []) as { meta: Record<string, number> | null }[];
const tweets = xr.reduce((a, r) => a + (r.meta?.tweets ?? 0), 0);
const requests = xr.reduce((a, r) => a + (r.meta?.requests ?? 0), 0);
console.log(`x: ${xr.length} markets, ${tweets} tweets, ${requests} requests, ${xr.filter((r) => r.meta?.capped).length} capped, ≈ $${Math.max(tweets * USD_PER_TWEET, requests * USD_PER_REQUEST_MIN).toFixed(3)}`);
const { data: ts } = await s.from('vi_samples').select('meta').eq('source', 'tiktok').gte('sampled_at', since);
const tr = (ts ?? []) as { meta: Record<string, number | string | null> | null }[];
const queried = tr.reduce((a, r) => a + Number(r.meta?.queried ?? 0), 0);
console.log(`tiktok: ${tr.length} markets sampled, ${queried} hashtags queried, ≈ $${(queried * usdPerHashtag()).toFixed(3)}`);
const { data: ss } = await s.from('vi_samples').select('meta').eq('source', 'tiktok_search').gte('sampled_at', since);
const sr = (ss ?? []) as { meta: Record<string, number | string | null> | null }[];
const searches = sr.reduce((a, r) => a + Number(r.meta?.searched ?? 0), 0);
const results = sr.reduce((a, r) => a + Number(r.meta?.results ?? 0), 0);
const rereads = sr.reduce((a, r) => a + Number(r.meta?.reads ?? 0), 0);
console.log(`tiktok_search: ${searches} searches (${results} results), ${rereads} re-reads, ≈ $${(results * usdPerSearchResult() + rereads * USD_PER_POST_READ).toFixed(3)}`);
const { data: rs } = await s.from('vi_samples').select('meta').eq('source', 'reddit').gte('sampled_at', since);
const rr = (rs ?? []) as { meta: Record<string, number | string | null> | null }[];
const rphrases = rr.reduce((a, r) => a + Number(r.meta?.searched ?? 0), 0);
const rresults = rr.reduce((a, r) => a + Number(r.meta?.results ?? 0), 0);
console.log(`reddit: ${rr.length} markets, ${rphrases} phrases, ${rresults} results, ${rr.filter((r) => Number(r.meta?.capped)).length} capped, ≈ $${(rresults * usdPerRedditResult()).toFixed(3)} plus $0.02 a run`);
const { data: is } = await s.from('vi_samples').select('meta').eq('source', 'instagram').gte('sampled_at', since);
const ir = (is ?? []) as { meta: Record<string, number | string | null> | null }[];
const iresults = ir.reduce((a, r) => a + Number(r.meta?.results ?? 0), 0);
console.log(`instagram: ${ir.length} tags read, ${iresults} reels, ${ir.filter((r) => Number(r.meta?.capped)).length} capped, ≈ $${(iresults * usdPerInstagramResult()).toFixed(3)}`);

console.log('\ntop and notable:');
const notable = new Set((process.env.VI_REPORT_NOTABLE ?? 'Meta,Doge,Clavicular,Google,Skibidi Toilet,Loki Edits,Goonmobile,Logan Paul,Michael Saylor,Kirkiversary,Anthropic').split(',').map((x) => x.trim()));
for (const m of rows.filter((r, i) => i < 5 || notable.has(r.entity_name))) {
  const c = (m.vi_components ?? {}) as Record<string, SourceComponent | undefined>;
  const parts = Object.entries(c).map(([n, v]) => `${n}=${v?.level ?? '∅'}${v?.momentum != null ? '/' + Number(v.momentum).toFixed(1) : ''}`).join(' ');
  console.log('  ', m.entity_name.padEnd(24), String(Math.round(Number(m.current_vi ?? 0))).padStart(4), viTier(Number(m.current_vi ?? 0)).label.padEnd(13), 'upd', age(m.vi_last_updated) + 'm', '|', parts);
}
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
