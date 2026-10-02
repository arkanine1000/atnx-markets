// Read-only audit of every live market's Virality Index: current score
// and tier, each source's stored level, momentum and age, vi_history
// coverage and ranges over 24 h and 7 d, the largest one-hour moves,
// aliases and the Wikipedia title behind the generic-term guard, cron
// health per hour over the last 48 h, and the tier distribution.
//
//   npm run vi:audit            # tables
//   npm run vi:audit -- --json  # everything, for a diff against an earlier run
//
// Writes nothing. Compare runs across the regimes listed in the VI
// calculation changelog before reading a score change as a signal.
import { createClient } from '@supabase/supabase-js';
import { viTier, isGenericTerm, searchableAliases, type Components, type SourceComponent } from '../lib/vi/score';
import { normalizeSearchTerm } from '../lib/vi/trends';

(async () => {

const s = createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { persistSession: false } });
const NOW = Date.now();
const H = 3600e3;
const MIN = 60e3;
const ageMin = (iso: string | null | undefined) => (iso ? Math.round((NOW - new Date(iso).getTime()) / MIN) : null);

interface MarketRow {
  id: string;
  entity_name: string;
  entity_type: string | null;
  category: string | null;
  created_at: string | null;
  current_vi: number | null;
  vi_last_updated: string | null;
  vi_components: Components | null;
  aliases: string[] | null;
  created_by: string | null;
  parent_market_id: string | null;
}
interface Point {
  t: number;
  vi: number;
  raw: number | null;
}

const { data: marketData, error } = await s
  .from('markets')
  .select('id, entity_name, entity_type, category, created_at, current_vi, vi_last_updated, vi_components, aliases, created_by, parent_market_id')
  .is('deleted_at', null)
  .order('created_at');
if (error) throw error;
const markets = (marketData ?? []) as unknown as MarketRow[];

// The eval tester's markets and captures are worth telling apart.
let evalId: string | null = null;
if (process.env.EVAL_USER_EMAIL) {
  try {
    const { data } = await s.auth.admin.listUsers({ perPage: 1000 });
    evalId = data.users.find((u) => u.email === process.env.EVAL_USER_EMAIL)?.id ?? null;
  } catch (e) {
    console.error('listUsers failed', (e as Error).message);
  }
}

const since = new Date(NOW - 8 * 24 * H).toISOString();
const hist: { market_id: string; vi: number; raw_vi: number | null; recorded_at: string }[] = [];
for (let from = 0; ; from += 1000) {
  const { data, error } = await s
    .from('vi_history')
    .select('market_id, vi, raw_vi, recorded_at')
    .gte('recorded_at', since)
    .order('recorded_at')
    .order('id')
    .range(from, from + 999);
  if (error) throw error;
  hist.push(...(data ?? []));
  if ((data ?? []).length < 1000) break;
}
const totalCount: Record<string, number> = {};
for (const m of markets) {
  const { count } = await s.from('vi_history').select('id', { count: 'exact', head: true }).eq('market_id', m.id);
  totalCount[m.id] = count ?? 0;
}
const capsBy: Record<string, { total: number; eval: number }> = {};
{
  const { data, error } = await s.from('captures').select('market_id, user_id').is('deleted_at', null);
  if (error) console.error('captures query failed', error.message);
  for (const c of data ?? []) {
    const k = c.market_id as string;
    capsBy[k] ??= { total: 0, eval: 0 };
    capsBy[k].total++;
    if (evalId && c.user_id === evalId) capsBy[k].eval++;
  }
}

const byMarket = new Map<string, Point[]>();
for (const r of hist) {
  if (!byMarket.has(r.market_id)) byMarket.set(r.market_id, []);
  byMarket.get(r.market_id)!.push({ t: new Date(r.recorded_at).getTime(), vi: Number(r.vi), raw: r.raw_vi === null ? null : Number(r.raw_vi) });
}

const sourceNames = new Set<string>();
const rows = markets.map((m) => {
  const pts = byMarket.get(m.id) ?? [];
  const win = (h: number) => pts.filter((p) => p.t >= NOW - h * H);
  const rng = (ps: Point[], k: 'vi' | 'raw' = 'vi') => {
    const v = ps.map((p) => p[k]).filter((x): x is number => x !== null);
    return v.length ? `${Math.min(...v).toFixed(1)}-${Math.max(...v).toFixed(1)}` : '-';
  };
  const p24 = win(24);
  const p7 = win(24 * 7);
  let lastChange: number | null = null;
  for (let i = 1; i < pts.length; i++) if (Math.abs(pts[i].vi - pts[i - 1].vi) >= 0.01) lastChange = pts[i].t;
  let maxMove = 0, maxMoveAt = 0, maxRaw = 0, maxRawAt = 0;
  for (let i = 0; i < p7.length; i++) {
    for (let j = i + 1; j < p7.length && p7[j].t - p7[i].t <= H; j++) {
      const d = Math.abs(p7[j].vi - p7[i].vi);
      if (d > maxMove) { maxMove = d; maxMoveAt = p7[j].t; }
      const a = p7[i].raw, b = p7[j].raw;
      if (a !== null && b !== null && Math.abs(b - a) > maxRaw) { maxRaw = Math.abs(b - a); maxRawAt = p7[j].t; }
    }
  }
  const comps = (m.vi_components ?? {}) as Record<string, SourceComponent | undefined>;
  const term = normalizeSearchTerm({ name: m.entity_name });
  const wiki = comps.wikipedia?.meta ?? null;
  const single = term.split(/\s+/).filter(Boolean).length === 1;
  const aliases = m.aliases ?? [];
  const src: Record<string, { level: number | null; momentum: number | null; ageMin: number | null; meta: SourceComponent['meta'] }> = {};
  for (const [k, c] of Object.entries(comps)) {
    if (!c) continue;
    sourceNames.add(k);
    src[k] = { level: c.level, momentum: c.momentum === null ? null : Number(Number(c.momentum).toFixed(2)), ageMin: ageMin(c.fetchedAt), meta: c.meta };
  }
  const vi = Number(m.current_vi ?? 0);
  return {
    name: m.entity_name, term, type: m.entity_type, category: m.category, created: m.created_at?.slice(0, 16) ?? null,
    createdBy: evalId && m.created_by === evalId ? 'EVAL' : m.created_by ? m.created_by.slice(0, 8) : null,
    parent: m.parent_market_id, captures: capsBy[m.id] ?? { total: 0, eval: 0 },
    vi, tier: viTier(vi).label, viUpdatedAgeMin: ageMin(m.vi_last_updated),
    src, aliases, searchable: searchableAliases(aliases, wiki), wikiTitle: (wiki?.title as string | null | undefined) ?? null,
    genericDropped: single && isGenericTerm(term, wiki, { entityType: m.entity_type }), single,
    total: totalCount[m.id], n24: p24.length, r24: rng(p24), raw24: rng(p24, 'raw'), n7: p7.length, r7: rng(p7), raw7: rng(p7, 'raw'),
    lastChangeAgeH: lastChange ? Number(((NOW - lastChange) / H).toFixed(1)) : null,
    distinctVi7: new Set(p7.map((p) => p.vi.toFixed(2))).size,
    maxMove1h: Number(maxMove.toFixed(1)), maxMoveAt: maxMoveAt ? new Date(maxMoveAt).toISOString().slice(0, 16) : null,
    maxRaw1h: Number(maxRaw.toFixed(1)), maxRawAt: maxRawAt ? new Date(maxRawAt).toISOString().slice(0, 16) : null,
  };
});

const perHour: Record<string, { pts: number; mk: Set<string>; minutes: Set<string> }> = {};
for (const r of hist) {
  const t = new Date(r.recorded_at).getTime();
  if (t < NOW - 48 * H) continue;
  const k = r.recorded_at.slice(0, 13);
  perHour[k] ??= { pts: 0, mk: new Set(), minutes: new Set() };
  perHour[k].pts++;
  perHour[k].mk.add(r.market_id);
  perHour[k].minutes.add(r.recorded_at.slice(14, 16));
}
const hours = [];
for (let h = 47; h >= 0; h--) {
  const k = new Date(NOW - h * H).toISOString().slice(0, 13);
  hours.push({ hour: k, pts: perHour[k]?.pts ?? 0, markets: perHour[k]?.mk.size ?? 0, minutes: [...(perHour[k]?.minutes ?? [])].sort().join(',') });
}
const tiers: Record<string, number> = {};
for (const r of rows) tiers[r.tier] = (tiers[r.tier] ?? 0) + 1;

const out = { now: new Date(NOW).toISOString(), evalId, liveMarkets: markets.length, histRows8d: hist.length, sources: [...sourceNames].sort(), rows, hours, tiers };
if (process.argv.includes('--json')) {
  console.log(JSON.stringify(out, null, 1));
  process.exit(0);
}

const sources = [...sourceNames].sort();
const fmtSrc = (x?: { level: number | null; momentum: number | null; ageMin: number | null }) => (x ? `${x.level ?? '∅'}/${x.momentum ?? '∅'}@${x.ageMin}m` : '-');
console.log(`now ${out.now}  live=${markets.length}  hist8d=${hist.length}  evalId=${evalId ?? '-'}`);
console.log(['name', 'type', 'cat', 'created', 'by', 'vi', 'tier', 'updAge', ...sources, 'tot', 'n24', 'r24', 'n7', 'r7', 'lastChgH', 'maxMove1h', 'maxRaw1h'].join(' | '));
for (const r of rows) {
  console.log([r.name, r.type, r.category, r.created, r.createdBy, r.vi.toFixed(1), r.tier, r.viUpdatedAgeMin, ...sources.map((k) => fmtSrc(r.src[k])), r.total, r.n24, r.r24, r.n7, r.r7, r.lastChangeAgeH, `${r.maxMove1h}@${r.maxMoveAt}`, `${r.maxRaw1h}@${r.maxRawAt}`].join(' | '));
}
console.log('\nALIASES / WIKI / META');
for (const r of rows) {
  console.log(`${r.name} [term="${r.term}"] single=${r.single} genericDropped=${r.genericDropped} wiki="${r.wikiTitle}" aliases=${JSON.stringify(r.aliases)} searchable=${JSON.stringify(r.searchable)} caps=${JSON.stringify(r.captures)} parent=${r.parent ?? ''}`);
  console.log(`   meta: ${Object.entries(r.src).map(([k, v]) => `${k}=${JSON.stringify(v.meta)}`).join(' ; ')}`);
}
console.log('\nHOURS (UTC) pts/markets/write-minutes');
for (const h of hours) console.log(`${h.hour} ${h.pts} ${h.markets} [${h.minutes}]`);
console.log('\nTIERS', tiers);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
