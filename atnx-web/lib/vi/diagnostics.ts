// What the admin's VI tab reads: the live breakdowns, one market's
// snapshots and series, and the day's samples, through the service role
// behind the admin action's role check (app/admin/actions.ts). Pure
// explaining is in lib/vi/explain.ts; this file only fetches, paginates
// past PostgREST's 1000-row cap, and hands the rows over. No
// `server-only` import, so a tsx script can reuse it.
import { createAdminClient } from '../supabase/admin';
import { CALIBRATION, type Components } from './score';
import { USD_PER_TWEET, USD_PER_REQUEST_MIN, xDailyBudget } from './x';
import { tiktokDailyBudget, usdPerHashtag } from './tiktok';
import { USD_PER_POST_READ, resultsPerSearch, tiktokSearchDailyBudget, tiktokSearchDailyReads, usdPerSearchResult } from './tiktok-search';
import { USD_PER_POST_READ_BY_PLATFORM, postDailyBudget } from './post';
import { YOUTUBE_SEARCH_BUDGET } from './youtube';
import {
  coverage,
  cronHealth,
  diagnoseMarket,
  explainMarket,
  explainMoves,
  spendToday,
  type MarketExplanation,
  type MovesExplanation,
  type Prices,
  type Snapshot,
  type SourceCoverage,
  type SpendRow,
  type ViMarketInput,
  type ViMarketRow,
} from './explain';

const HOUR = 3600_000;
const DAY = 24 * HOUR;
const MISSING_TABLE = new Set(['42P01', 'PGRST205']);

export function pricesNow(): Prices {
  return {
    usdPerTweet: USD_PER_TWEET,
    usdPerRequestMin: USD_PER_REQUEST_MIN,
    usdPerHashtag: usdPerHashtag(),
    usdPerSearchResult: usdPerSearchResult(),
    resultsPerSearch: resultsPerSearch(),
    usdPerPostRead: { tiktok: USD_PER_POST_READ, instagram: USD_PER_POST_READ_BY_PLATFORM.instagram, x: USD_PER_POST_READ_BY_PLATFORM.x },
  };
}

export interface Budgets {
  x: { label: string; budget: number; unit: string };
  tiktok: { label: string; budget: number; unit: string };
  tiktok_search: { label: string; budget: number; unit: string; reads: number };
  post: { label: string; budget: number; unit: string };
  youtube: { label: string; budget: number; unit: string };
}
export function budgetsNow(): Budgets {
  return {
    x: { label: 'X', budget: xDailyBudget(), unit: 'posts a day' },
    tiktok: { label: 'TikTok hashtag', budget: tiktokDailyBudget(), unit: 'hashtags a day' },
    tiktok_search: { label: 'TikTok search', budget: tiktokSearchDailyBudget(), unit: 'searches a day', reads: tiktokSearchDailyReads() },
    post: { label: 'Captured posts', budget: postDailyBudget(), unit: 'reads a day' },
    youtube: { label: 'YouTube', budget: YOUTUBE_SEARCH_BUDGET, unit: 'searches a day (quota)' },
  };
}

// Every row of a query, a page at a time, in the order the builder sets.
// The rows come back typed by the generated schema; callers name the
// shape they read (jsonb columns are `Json` there).
export async function selectAll<T>(build: (from: number, to: number) => PromiseLike<{ data: unknown; error: { message: string } | null }>, page = 1000): Promise<T[]> {
  const out: T[] = [];
  for (let from = 0; ; from += page) {
    const { data, error } = await build(from, from + page - 1);
    if (error) throw new Error(error.message);
    const rows = (data ?? []) as T[];
    out.push(...rows);
    if (rows.length < page) return out;
  }
}

interface MarketRow {
  id: string;
  entity_name: string;
  entity_type: string | null;
  category: string | null;
  aliases: string[] | null;
  current_vi: number | null;
  vi_state: string | null;
  vi_last_updated: string | null;
  created_at: string | null;
  vi_components: Components | null;
}
const MARKET_COLUMNS = 'id, entity_name, entity_type, category, aliases, current_vi, vi_state, vi_last_updated, created_at, vi_components';

function toInput(m: MarketRow): ViMarketInput {
  return { id: m.id, name: m.entity_name, entityType: m.entity_type, category: m.category, currentVi: m.current_vi === null ? null : Number(m.current_vi), viState: m.vi_state, viLastUpdated: m.vi_last_updated, createdAt: m.created_at, aliases: m.aliases ?? [], components: m.vi_components };
}

type SeriesMap = Map<string, [number, number][]>;
async function series(ids: string[], sinceMs: number, bucketSeconds: number): Promise<SeriesMap> {
  const out: SeriesMap = new Map();
  if (ids.length === 0) return out;
  const { data, error } = await createAdminClient().rpc('vi_history_series', { market_ids: ids, since: new Date(sinceMs).toISOString(), bucket_seconds: bucketSeconds });
  if (error) throw new Error(error.message);
  for (const row of data ?? []) out.set(row.market_id, ((row.points ?? []) as [number, number][]).map(([t, v]) => [Number(t), Number(v)]));
  return out;
}

export interface ViOverview {
  asOf: string;
  rows: ViMarketRow[];
  coverage: SourceCoverage[];
  tiers: Record<string, number>;
  live: number;
}

export async function loadViOverview(now = Date.now()): Promise<ViOverview> {
  const db = createAdminClient();
  const markets = await selectAll<MarketRow>((from, to) => db.from('markets').select(MARKET_COLUMNS).is('deleted_at', null).order('id').range(from, to));
  const inputs = markets.map(toInput);
  const byDay = await series(inputs.map((m) => m.id), now - 25 * HOUR, 3600).catch(() => new Map() as SeriesMap);
  const prices = pricesNow();
  const rows = inputs.map((m) => {
    const pts = byDay.get(m.id) ?? [];
    // The bucket nearest 24 h back against the latest, as the market page does.
    const target = now - DAY;
    const base = pts.length >= 2 ? pts.reduce((best, p) => (Math.abs(p[0] - target) < Math.abs(best[0] - target) ? p : best), pts[0]) : null;
    const d24 = base && base[1] > 0 && m.currentVi !== null ? Math.round(((m.currentVi - base[1]) / base[1]) * 1000) / 10 : null;
    return diagnoseMarket(m, { now, prices, d24, cal: CALIBRATION });
  });
  const tiers: Record<string, number> = {};
  for (const r of rows) tiers[r.tier] = (tiers[r.tier] ?? 0) + 1;
  return { asOf: new Date(now).toISOString(), rows, coverage: coverage(inputs, now, CALIBRATION), tiers, live: inputs.filter((m) => m.viState === 'live').length };
}

export interface ViMarketDetail {
  asOf: string;
  market: { id: string; name: string; category: string | null; entityType: string | null; viState: string | null; currentVi: number | null; createdAt: string | null };
  explanation: MarketExplanation;
  moves: MovesExplanation;
  series: { date: string; value: number }[];
  snapshots: number;
  historyAvailable: boolean;
}

export async function loadViMarket(marketId: string, window: '24h' | '7d', now = Date.now()): Promise<ViMarketDetail | null> {
  const db = createAdminClient();
  const windowMs = window === '24h' ? DAY : 7 * DAY;
  const windowStart = now - windowMs;
  const [marketRes, snapRes, pts, lastRes] = await Promise.all([
    db.from('markets').select(MARKET_COLUMNS).eq('id', marketId).maybeSingle(),
    db.from('vi_component_history').select('recorded_at, components, raw_vi, vi, attention').eq('market_id', marketId).gte('recorded_at', new Date(windowStart - 75 * 60_000).toISOString()).order('recorded_at'),
    series([marketId], windowStart, window === '24h' ? 300 : 1800).catch(() => new Map() as SeriesMap),
    db.from('vi_history').select('raw_vi, vi, recorded_at').eq('market_id', marketId).order('recorded_at', { ascending: false }).limit(1).maybeSingle(),
  ]);
  if (marketRes.error) throw new Error(marketRes.error.message);
  if (!marketRes.data) return null;
  const m = toInput(marketRes.data as MarketRow);
  const historyAvailable = !(snapRes.error && MISSING_TABLE.has(snapRes.error.code ?? ''));
  if (snapRes.error && historyAvailable) throw new Error(snapRes.error.message);
  const snaps: Snapshot[] = ((snapRes.data ?? []) as { recorded_at: string; components: Components; raw_vi: number | null; vi: number | null; attention: number | null }[]).map((r) => ({
    at: r.recorded_at,
    components: r.components ?? {},
    raw: r.raw_vi === null ? null : Number(r.raw_vi),
    vi: r.vi === null ? null : Number(r.vi),
    attention: r.attention === null ? null : Number(r.attention),
  }));
  const latestRaw = lastRes.data?.raw_vi == null ? null : Number(lastRes.data.raw_vi);
  const prices = pricesNow();
  return {
    asOf: new Date(now).toISOString(),
    market: { id: m.id, name: m.name, category: m.category, entityType: m.entityType, viState: m.viState, currentVi: m.currentVi, createdAt: m.createdAt ?? null },
    explanation: explainMarket(m, { now, prices, latestRaw, cal: CALIBRATION }),
    moves: explainMoves(snaps, { windowStartMs: windowStart, maxMoves: window === '24h' ? 8 : 15, category: m.category, now, cal: CALIBRATION }),
    series: (pts.get(marketId) ?? []).map(([t, v]) => ({ date: new Date(t).toISOString(), value: v })),
    snapshots: snaps.length,
    historyAvailable,
  };
}

export interface ViHealth {
  asOf: string;
  spend: SpendRow[];
  budgets: Budgets;
  use: Record<string, number>;
  lastSampleAt: Record<string, string | null>;
  cron: ReturnType<typeof cronHealth>;
  live: number;
}

const SPEND_KEYS: Record<string, string[]> = {
  x: ['tweets', 'requests'],
  x_account: ['tweets', 'requests'],
  tiktok: ['queried'],
  tiktok_search: ['searched', 'results', 'reads'],
  post: ['reads', 'platform'],
  youtube: ['searched'],
};

export async function loadViHealth(now = Date.now()): Promise<ViHealth> {
  const db = createAdminClient();
  const dayStart = new Date(now - (now % DAY)).toISOString();
  const sources = Object.keys(SPEND_KEYS);
  const [sampleRows, lastRows, liveIds, snapshotRows] = await Promise.all([
    Promise.all(
      sources.map((source) =>
        selectAll<Record<string, unknown>>((from, to) =>
          db
            .from('vi_samples')
            .select(`id, ${SPEND_KEYS[source].map((k) => `${k}:meta->${k}`).join(', ')}`)
            .eq('source', source)
            .gte('sampled_at', dayStart)
            .order('id')
            .range(from, to)
        ).then((rows) => rows.map((r) => ({ source, meta: r })))
      )
    ),
    Promise.all([...sources, 'gdelt'].map((source) => db.from('vi_samples').select('sampled_at').eq('source', source).order('sampled_at', { ascending: false }).limit(1).maybeSingle().then((r) => [source, (r.data?.sampled_at as string | undefined) ?? null] as const))),
    db.from('markets').select('id').is('deleted_at', null).eq('vi_state', 'live').then((r) => (r.data ?? []).map((m) => m.id as string)),
    selectAll<{ market_id: string; recorded_at: string }>((from, to) => db.from('vi_component_history').select('market_id, recorded_at').gte('recorded_at', new Date(now - DAY).toISOString()).order('id').range(from, to)).catch(() => [] as { market_id: string; recorded_at: string }[]),
  ]);
  const fastSeries = await series(liveIds, now - DAY, 300).catch(() => new Map() as SeriesMap);
  const rows = sampleRows.flat();
  const prices = pricesNow();
  const spend = spendToday(rows, prices);
  const unit = (source: string, key: string) => rows.filter((r) => r.source === source).reduce((s, r) => s + (Number(r.meta?.[key]) || 0), 0);
  return {
    asOf: new Date(now).toISOString(),
    spend,
    budgets: budgetsNow(),
    use: { x: unit('x', 'tweets') + unit('x_account', 'tweets'), tiktok: unit('tiktok', 'queried'), tiktok_search: unit('tiktok_search', 'searched'), tiktok_search_reads: unit('tiktok_search', 'reads'), post: unit('post', 'reads'), youtube: unit('youtube', 'searched') },
    lastSampleAt: Object.fromEntries(lastRows),
    cron: cronHealth({ fastSeries, snapshots: snapshotRows, liveCount: liveIds.length, now }),
    live: liveIds.length,
  };
}
