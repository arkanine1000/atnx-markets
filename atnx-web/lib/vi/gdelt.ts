// GDELT news coverage as a VI source, from GDELT's Global Knowledge Graph
// on BigQuery (gdelt-bq.gdeltv2.gkg_partitioned, public, one partition per
// UTC day, about an hour behind). The DOC 2.0 API this replaced is
// throttled by design and answered for 11 of 52 markets by 2026-09-25.
//
// An hourly job (runGdeltJob, called by the slow refresh before scoring)
// counts, per market and day, the articles whose extracted names contain
// the market's name or an alias as a whole entry, or whose page title
// contains it as whole words, against the day's total, and writes that
// share to vi_samples, zeros included. Today is re-counted every hour;
// yesterday until 03:00 UTC, when its partition is complete. Markets with
// under a week of samples (new ones, and everyone at launch) get a 14-day
// backfill. The reading is computed from those samples, with no network
// call, and is unknown rather than zero when the job has fallen behind.
//
// Scope: not the memes category. Coined meme names rarely reach the news
// and their phrases collide with ordinary text ("November 2026" is a
// date); in the 14-day check memes were covered 4/20 against 67-100% for
// every other category. Elsewhere "no articles" is a real zero.
//
// Cost: a day's partition is ~0.1 GB for names and ~0.13 GB more for page
// titles; about 150-200 GB a month in all, inside BigQuery's free 1 TiB
// (the project is a sandbox, which caps it there). Every job has a
// bytes-billed cap.
import { createAdminClient } from '@/lib/supabase/admin';
import { bigqueryConfigured, query } from './bigquery';
import { readSamples, type Sample } from './samples';
import { clamp, isGenericTerm, isSearchableAlias, ratioToBaseline, type SourceComponent } from './score';

const GB = 1024 ** 3;
const HOURLY_MAX_BYTES = 2 * GB;
const BACKFILL_MAX_BYTES = 6 * GB;
const BACKFILL_DAYS = 14;
// A market with fewer days of samples than this is backfilled.
const MIN_HISTORY_DAYS = 7;
// Backfills run at this UTC hour, or at once when this many markets need
// one (launch, a burst of new markets).
const BACKFILL_HOUR = 3;
const BACKFILL_NOW = 10;
// Yesterday's partition is complete by this UTC hour.
const YESTERDAY_UNTIL_HOUR = 3;
// Today counts toward the reading once it holds this many articles
// (~2-3 hours of a ~310k-article day); a smaller share is too noisy.
const MIN_PARTIAL_TOTAL = 30_000;
const MAX_PHRASES = 4;
const SAMPLE_LIMIT = 60;
// Momentum needs this many matched articles a day on average before the
// latest one: under it a quiet day is a coin toss, not a collapse.
const MIN_PRIOR_COUNT = 3;
// When the switch from the DOC API took effect: scores blend from the
// old composite to the new one over the ramp (lib/vi/score.ts).
export const GDELT_BQ_SINCE = Date.parse('2026-09-25T18:00:00Z');

// The share (%) of the day's monitored articles that mention the market.
// Maps to level on a log scale (the same scale the DOC API's timelinevol
// share used, so levels carried over):
//   0.0001% -> 0, 0.001% -> 250, 0.01% -> 500, 0.1% -> 750, 1%+ -> 1000
export function gdeltLevel(meanPct: number): number {
  if (meanPct <= 0) return 0;
  return clamp(Math.round(((Math.log10(meanPct) + 4) / 4) * 1000));
}

export interface DayShare {
  day: string; // YYYY-MM-DD, UTC
  value: number; // share (%) of the day's articles
  count?: number; // articles matched that day
}

const DAY_MS = 24 * 3600 * 1000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export interface GdeltReading {
  level: number | null;
  momentum: number | null;
  meanPct: number;
  latestPct: number | null;
  latestDay: string | null;
  days: number;
}

const LEVEL_WINDOW_DAYS = 7;
const BASELINE_DAYS = 13;
const MIN_PRIOR_DAYS = 3;
// A latest day older than this means GDELT is behind, not that coverage
// stopped; momentum is unknown until it catches up.
const MAX_LATEST_AGE_DAYS = 2;

// Level from the last seven days that are present; momentum from the
// latest full day against the days before it. Sparse or stale series
// give an unknown momentum rather than a false collapse.
export function gdeltReading(days: DayShare[], now = Date.now()): GdeltReading {
  if (days.length === 0) return { level: null, momentum: null, meanPct: 0, latestPct: null, latestDay: null, days: 0 };
  const windowStart = utcDay(now - LEVEL_WINDOW_DAYS * DAY_MS);
  const recent = days.filter((d) => d.day >= windowStart);
  // Nothing in the last week but data before it: the term has gone quiet.
  const meanPct = recent.length ? recent.reduce((s, d) => s + d.value, 0) / recent.length : 0;

  const latest = days[days.length - 1];
  const prior = days.slice(0, -1).slice(-BASELINE_DAYS);
  const stale = latest.day < utcDay(now - MAX_LATEST_AGE_DAYS * DAY_MS);
  const sparse = prior.length < MIN_PRIOR_DAYS || prior.filter((d) => d.value > 0).length < MIN_PRIOR_DAYS;
  const momentum = stale || sparse ? null : ratioToBaseline(latest.value, prior.map((d) => d.value));

  return {
    level: gdeltLevel(meanPct),
    momentum,
    meanPct,
    latestPct: latest.value,
    latestDay: latest.day,
    days: days.length,
  };
}

const RESOLUTION = '1d-gkg';

// The phrases a market is counted by: its name and searchable aliases,
// case-insensitively distinct. Pure.
export function gdeltPhrases(name: string, aliases: string[] = []): string[] {
  return [name, ...aliases.filter(isSearchableAlias)]
    .map((p) => p.trim().replace(/"/g, ''))
    .filter((p, i, all) => p.length >= 2 && all.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i)
    .slice(0, MAX_PHRASES);
}

// RE2 patterns over the lower-cased columns. AllNames is "Name,offset;..."
// so a whole entry is `(^|;)name,` (Meta, not Metallica); a title match is
// whole words. Pure.
export function gdeltPatterns(phrases: string[]): { names: string; title: string } {
  const alt = phrases.map((p) => p.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
  return { names: `(^|;)(${alt}),`, title: `\\b(${alt})\\b` };
}

export function gdeltApplies(category: string | null | undefined): boolean {
  return category !== 'memes';
}

// One query for many markets and days: per market and day, the stories
// matched by names or title, and the day's total. A story is a distinct
// page title (the URL when there is none): one wire piece syndicated to
// forty regional papers is one story, not forty (a book review mentioning
// MrBeast read as a 10x news spike before this).
const COUNT_SQL = `
WITH m AS (
  SELECT id, n, t FROM UNNEST(@ids) AS id WITH OFFSET o
  JOIN UNNEST(@names) AS n WITH OFFSET o2 ON o = o2
  JOIN UNNEST(@titles) AS t WITH OFFSET o3 ON o = o3
),
g AS (
  SELECT DATE(_PARTITIONTIME) AS day, LOWER(AllNames) AS names, title,
         -- The story key: the title without a trailing " | Site" or
         -- " - Site", which is all that tells syndicated copies apart.
         COALESCE(REGEXP_REPLACE(title, r'\\s+[|\\-–—]\\s+[^|–—]{1,60}$', ''), DocumentIdentifier) AS doc
  FROM (
    SELECT _PARTITIONTIME, AllNames, DocumentIdentifier,
           LOWER(REGEXP_EXTRACT(Extras, r'<PAGE_TITLE>(.*?)</PAGE_TITLE>')) AS title
  FROM \`gdelt-bq.gdeltv2.gkg_partitioned\`
  WHERE _PARTITIONTIME >= TIMESTAMP(@from_day) AND _PARTITIONTIME < TIMESTAMP_ADD(TIMESTAMP(@to_day), INTERVAL 1 DAY)
  )
),
totals AS (SELECT day, COUNT(DISTINCT doc) AS total FROM g GROUP BY day),
hits AS (
  SELECT m.id, g.day, COUNT(DISTINCT g.doc) AS count
  FROM g CROSS JOIN m
  WHERE REGEXP_CONTAINS(g.names, m.n) OR REGEXP_CONTAINS(g.title, m.t)
  GROUP BY m.id, g.day
)
SELECT CAST(totals.day AS STRING) AS day, totals.total, hits.id, hits.count
FROM totals LEFT JOIN hits USING (day)`;

interface JobMarket {
  id: string;
  name: string;
  phrases: string[];
}

async function countDays(markets: JobMarket[], fromDay: string, toDay: string, maxBytes: number) {
  const pats = markets.map((m) => gdeltPatterns(m.phrases));
  const r = await query(COUNT_SQL, {
    maxBytes,
    timeoutMs: 300_000,
    params: [
      { name: 'ids', type: 'ARRAY<STRING>', value: markets.map((m) => m.id) },
      { name: 'names', type: 'ARRAY<STRING>', value: pats.map((p) => p.names) },
      { name: 'titles', type: 'ARRAY<STRING>', value: pats.map((p) => p.title) },
      { name: 'from_day', type: 'STRING', value: fromDay },
      { name: 'to_day', type: 'STRING', value: toDay },
    ],
  });
  const totals = new Map<string, number>();
  const counts = new Map<string, number>();
  for (const row of r.rows) {
    totals.set(row.day!, Number(row.total));
    if (row.id) counts.set(`${row.id}|${row.day}`, Number(row.count));
  }
  return { totals, counts, bytesBilled: r.bytesBilled };
}

// Replaces the markets' samples for the given days with fresh counts,
// explicit zeros included, so "no articles" and "not counted" differ.
async function writeDays(markets: JobMarket[], totals: Map<string, number>, counts: Map<string, number>, final: (day: string) => boolean) {
  const days = [...totals.keys()];
  if (days.length === 0 || markets.length === 0) return 0;
  const db = createAdminClient();
  const ids = markets.map((m) => m.id);
  const { error: delErr } = await db.from('vi_samples').delete().eq('source', 'gdelt').in('market_id', ids).in('meta->>day', days);
  if (delErr) throw new Error(`gdelt samples delete: ${delErr.message}`);
  const now = new Date().toISOString();
  const rows = markets.flatMap((m) =>
    days.map((day) => {
      const total = totals.get(day)!;
      const count = counts.get(`${m.id}|${day}`) ?? 0;
      return { market_id: m.id, source: 'gdelt', sampled_at: now, value: total > 0 ? (100 * count) / total : 0, meta: { day, count, total, final: final(day), resolution: RESOLUTION } };
    })
  );
  for (let i = 0; i < rows.length; i += 500) {
    const { error } = await db.from('vi_samples').insert(rows.slice(i, i + 500));
    if (error) throw new Error(`gdelt samples insert: ${error.message}`);
  }
  return rows.length;
}

export interface GdeltJobSummary {
  markets: number;
  days: string[];
  backfilled: number;
  rows: number;
  gbBilled: number;
  skipped?: string;
}

// The hourly count. Safe to run more often: each run replaces the rows
// for the days it counted. `marketIds` limits it to those markets (a new
// market's first pass counts today only, ~0.25 GB; its history comes with
// the 03:00 backfill).
export async function runGdeltJob(now = Date.now(), { marketIds, backfill = true }: { marketIds?: string[]; backfill?: boolean } = {}): Promise<GdeltJobSummary> {
  const summary: GdeltJobSummary = { markets: 0, days: [], backfilled: 0, rows: 0, gbBilled: 0 };
  if (!bigqueryConfigured()) return { ...summary, skipped: 'GCP_SA_KEY_B64 not set' };
  const db = createAdminClient();
  let q = db.from('markets').select('id, entity_name, entity_type, category, aliases, vi_components').is('deleted_at', null);
  if (marketIds) q = q.in('id', marketIds);
  const { data, error } = await q;
  if (error) throw new Error(error.message);
  const markets: JobMarket[] = [];
  for (const m of data ?? []) {
    if (!gdeltApplies(m.category)) continue;
    const wiki = (m.vi_components as Record<string, SourceComponent | undefined> | null)?.wikipedia?.meta;
    if (isGenericTerm(m.entity_name, wiki, { entityType: m.entity_type })) continue;
    const phrases = gdeltPhrases(m.entity_name, (m.aliases as string[] | null) ?? []);
    if (phrases.length) markets.push({ id: m.id, name: m.entity_name, phrases });
  }
  summary.markets = markets.length;
  if (markets.length === 0) return summary;

  const today = utcDay(now);
  const yesterday = utcDay(now - DAY_MS);
  const hour = new Date(now).getUTCHours();
  const from = hour < YESTERDAY_UNTIL_HOUR ? yesterday : today;
  const hourly = await countDays(markets, from, today, HOURLY_MAX_BYTES);
  summary.rows += await writeDays(markets, hourly.totals, hourly.counts, (d) => d < today);
  summary.days = [...hourly.totals.keys()].sort();
  summary.gbBilled += hourly.bytesBilled / GB;

  if (!backfill) {
    summary.gbBilled = Number(summary.gbBilled.toFixed(3));
    return summary;
  }
  // Markets short of a week of history.
  const since = utcDay(now - BACKFILL_DAYS * DAY_MS);
  const { data: have, error: haveErr } = await db
    .from('vi_samples')
    .select('market_id, meta')
    .eq('source', 'gdelt')
    .in('market_id', markets.map((m) => m.id))
    .gte('meta->>day', since);
  if (haveErr) throw new Error(haveErr.message);
  const daysPer = new Map<string, Set<string>>();
  for (const r of have ?? []) {
    const d = (r.meta as { day?: string } | null)?.day;
    if (d) (daysPer.get(r.market_id) ?? daysPer.set(r.market_id, new Set()).get(r.market_id)!).add(d);
  }
  const short = markets.filter((m) => (daysPer.get(m.id)?.size ?? 0) < MIN_HISTORY_DAYS);
  if (short.length && (hour === BACKFILL_HOUR || short.length >= BACKFILL_NOW)) {
    const back = await countDays(short, since, yesterday, BACKFILL_MAX_BYTES);
    summary.rows += await writeDays(short, back.totals, back.counts, () => true);
    summary.backfilled = short.length;
    summary.gbBilled += back.bytesBilled / GB;
  }
  summary.gbBilled = Number(summary.gbBilled.toFixed(3));
  return summary;
}

// Daily shares from a market's samples, oldest first: the newest row per
// day wins; today only once it holds enough articles. Pure.
export function samplesToDays(samples: Sample[], now = Date.now()): DayShare[] {
  const today = utcDay(now);
  const byDay = new Map<string, { at: string; value: number; total: number; count: number }>();
  for (const smp of samples) {
    const day = typeof smp.meta?.day === 'string' ? smp.meta.day : null;
    if (!day || day > today) continue;
    const prev = byDay.get(day);
    if (!prev || smp.sampled_at > prev.at) byDay.set(day, { at: smp.sampled_at, value: Number(smp.value), total: Number(smp.meta?.total ?? 0), count: Number(smp.meta?.count ?? 0) });
  }
  return [...byDay.entries()]
    .filter(([day, d]) => day < today || d.total >= MIN_PARTIAL_TOTAL)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, d]) => ({ day, value: d.value, count: d.count }));
}

// The reading from samples: unknown with no history, or when the newest
// counted day is over two days old (the job stopped; not "no news"). The
// level includes today's partial share, so it moves within the hour; the
// momentum compares complete days only, and only for a market with enough
// articles a day for a quiet day to mean something. Pure.
export function gdeltFromDays(days: DayShare[], now = Date.now()): SourceComponent {
  const at = new Date(now).toISOString();
  const unknown: SourceComponent = { source: 'gdelt', level: null, momentum: null, fetchedAt: at, meta: { resolution: RESOLUTION } };
  if (days.length === 0) return unknown;
  const newest = days[days.length - 1].day;
  if (newest < utcDay(now - 2 * DAY_MS)) return unknown;
  const r = gdeltReading(days, now);
  const today = utcDay(now);
  const complete = days.filter((d) => d.day < today);
  const prior = complete.slice(0, -1).slice(-13);
  const priorCount = prior.length ? prior.reduce((a, d) => a + (d.count ?? 0), 0) / prior.length : 0;
  const momentum = priorCount >= MIN_PRIOR_COUNT ? gdeltReading(complete, now).momentum : null;
  return {
    source: 'gdelt',
    level: r.level,
    momentum,
    fetchedAt: at,
    meta: {
      articles_pct_7d: Number(r.meanPct.toPrecision(4)),
      articles_pct_latest: r.latestPct === null ? null : Number(r.latestPct.toPrecision(4)),
      latest_day: r.latestDay,
      days: r.days,
      resolution: RESOLUTION,
    },
  };
}

// The slow path's GDELT reading for one market. Null (keep the stored
// reading) when it cannot be asked; the category rule is the caller's.
export async function readGdeltSignal(marketId: string | null | undefined, now = Date.now()): Promise<SourceComponent | null> {
  if (!marketId) return null;
  return gdeltFromDays(samplesToDays(await readSamples(marketId, 'gdelt', SAMPLE_LIMIT), now), now);
}
