// GDELT DOC 2.0 news volume as a VI source. Free, no auth, but strict: one
// request per 5 seconds per IP, 429 otherwise. Calls are serialised through
// a module-level queue and cached for most of an hour; the slow refresh
// path owns this source.
//
// The timeline's resolution follows the timespan: under 72 h it is
// 15-minute, up to a week hourly, beyond a week daily. We ask for 14 days
// so the points are days, and bucket by UTC day regardless, so a change in
// resolution cannot break the momentum. A day GDELT has no data for is
// left out of the daily series (hourly series zero-fill it instead, which
// read as a collapse); a missing day is unknown here, never zero.
import { clamp, ratioToBaseline, type SourceComponent } from './score';

const API = 'https://api.gdeltproject.org/api/v2/doc/doc';
const MIN_GAP_MS = 5_200;
const RETRIES_429 = 1;
const BACKOFF_MS = 8_000;
// Under the hour, so the next hourly run refetches instead of reading a
// warm instance's cache.
const CACHE_TTL = 50 * 60 * 1000;
const USER_AGENT = 'ATNX/1.0 (attention-exchange; contact@atnx.app)';
const TIMESPAN = '14d';
// After this many failures in a row (429s, or the connection not opening
// at all, which is how GDELT looks when it is overloaded) stop asking for
// a while rather than burn the run's budget on back-offs and timeouts.
// Time-based, since warm instances share module state across runs. The
// pause is short enough for the same hourly run to try again: a run
// pauses at most a few times inside its GDELT budget.
const BREAKER_TRIP = 4;
const BREAKER_PAUSE_MS = 3 * 60 * 1000;
// A connection that has not opened by then will not.
const CONNECT_TIMEOUT_MS = 8_000;

const cache = new Map<string, { data: SourceComponent; expiry: number }>();

let consecutiveFailures = 0;
let pausedUntil = 0;
function failed(term: string, what: string): void {
  consecutiveFailures++;
  if (consecutiveFailures >= BREAKER_TRIP) {
    pausedUntil = Date.now() + BREAKER_PAUSE_MS;
    console.error(`[gdelt] ${consecutiveFailures} consecutive failures (${what} for "${term}"); pausing ${BREAKER_PAUSE_MS / 60000} min`);
  }
}
export function gdeltPaused(now = Date.now()): boolean {
  return now < pausedUntil;
}

// Serialise requests so a batch never trips the per-IP limit. The
// deadline is checked when a call is about to start, not when it is
// queued: a queue of fifty markets at 5 s each is the whole budget.
let chain: Promise<unknown> = Promise.resolve();
let lastCallAt = 0;
function scheduled<T>(fn: () => Promise<T>, deadline: number | undefined, onSkip: () => T): Promise<T> {
  const run = chain.then(async () => {
    if (deadline !== undefined && Date.now() >= deadline) return onSkip();
    const wait = lastCallAt + MIN_GAP_MS - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastCallAt = Date.now();
    return fn();
  });
  chain = run.catch(() => undefined);
  return run;
}

// timelinevol returns the share (%) of all monitored articles that match
// the query. Maps to level on a log scale:
//   0.0001% -> 0, 0.001% -> 250, 0.01% -> 500, 0.1% -> 750, 1%+ -> 1000
export function gdeltLevel(meanPct: number): number {
  if (meanPct <= 0) return 0;
  return clamp(Math.round(((Math.log10(meanPct) + 4) / 4) * 1000));
}

export interface DayShare {
  day: string; // YYYY-MM-DD, UTC
  value: number; // mean share over the day's points
  steps: number;
}

const DAY_MS = 24 * 3600 * 1000;
const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

// Groups timeline points by UTC day. The value is a per-step share, so a
// day's value is the mean of its steps, not their sum. Today (partial)
// and anything later are dropped. A sub-daily series zero-fills the days
// GDELT has no data for, where a daily series leaves them out; a day of
// nothing but zeros in a sub-daily series is dropped the same way.
export function dailyShares(points: { date: string; value: number }[], now = Date.now()): DayShare[] {
  const today = utcDay(now);
  const acc = new Map<string, { sum: number; steps: number }>();
  for (const p of points) {
    const m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(p.date ?? '');
    if (!m || !Number.isFinite(p.value)) continue;
    const day = `${m[1]}-${m[2]}-${m[3]}`;
    if (day >= today) continue;
    const a = acc.get(day) ?? { sum: 0, steps: 0 };
    a.sum += p.value;
    a.steps++;
    acc.set(day, a);
  }
  return [...acc.entries()]
    .filter(([, a]) => a.steps === 1 || a.sum > 0)
    .sort(([a], [b]) => (a < b ? -1 : 1))
    .map(([day, a]) => ({ day, value: a.sum / a.steps, steps: a.steps }));
}

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

const MAX_PHRASES = 4;

export interface GdeltOptions {
  // Epoch ms after which no request is started; the reading is then
  // unknown and the caller keeps its stored one. 0 skips the source.
  deadline?: number;
}

export async function fetchGdeltSignal(term: string, aliases: string[] = [], { deadline }: GdeltOptions = {}): Promise<SourceComponent> {
  // The name and up to three aliases as one OR query; GDELT counts an
  // article once however many phrases it matches.
  const phrases = [term, ...aliases]
    .map((p) => p.trim().replace(/"/g, ''))
    .filter((p, i, all) => p.length >= 2 && all.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i)
    .slice(0, MAX_PHRASES);
  const key = phrases.join('|').toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiry) return hit.data;

  const empty: SourceComponent = {
    source: 'gdelt',
    level: null,
    momentum: null,
    fetchedAt: new Date().toISOString(),
  };
  if (phrases.length === 0) return empty;
  if (deadline !== undefined && Date.now() >= deadline) return empty;
  if (gdeltPaused()) return empty;

  const quoted = phrases.map((p) => `"${p}"`);
  const params = new URLSearchParams({
    query: quoted.length === 1 ? quoted[0] : `(${quoted.join(' OR ')})`,
    mode: 'timelinevol',
    timespan: TIMESPAN,
    format: 'json',
  });

  try {
    // The per-IP limit is shared with whoever else is behind the same
    // egress address, so a 429 can arrive even at our own 5 s spacing.
    let res: Response | null = null;
    for (let attempt = 0; attempt <= RETRIES_429; attempt++) {
      if (attempt > 0) await new Promise((r) => setTimeout(r, BACKOFF_MS));
      if (gdeltPaused()) return empty;
      res = await scheduled(
        () =>
          fetch(`${API}?${params}`, {
            headers: { 'User-Agent': USER_AGENT },
            cache: 'no-store',
            signal: AbortSignal.timeout(CONNECT_TIMEOUT_MS),
          }),
        deadline,
        () => null
      );
      if (res === null) return empty; // deadline passed while queued
      if (res.status === 429) {
        failed(term, '429');
        if (gdeltPaused()) return empty;
        continue;
      }
      consecutiveFailures = 0;
      break;
    }
    if (!res || !res.ok) {
      // Not cached: the next pass tries again.
      console.error(`[gdelt] ${res?.status ?? 'no response'} for "${term}"`);
      return empty;
    }
    const text = await res.text();
    // GDELT answers "{}" for no matches, an empty body when overloaded, and
    // a plain-text sentence for queries it will not run (too short, etc).
    if (text.trim() && !text.trim().startsWith('{')) {
      console.error(`[gdelt] refused "${term}": ${text.trim().slice(0, 80)}`);
      return empty;
    }
    if (!text.trim() || text.trim() === '{}') {
      const none: SourceComponent = { ...empty, level: 0, meta: { articles_pct_7d: 0 } };
      cache.set(key, { data: none, expiry: Date.now() + CACHE_TTL });
      return none;
    }
    const body = JSON.parse(text) as {
      query_details?: { date_resolution?: string };
      timeline?: { data?: { date: string; value: number }[] }[];
    };
    const points = body.timeline?.[0]?.data ?? [];
    const days = dailyShares(points);
    // Points but no usable day (a sub-daily series of zeros): nothing
    // matched, which is a real zero.
    const reading = days.length === 0 && points.length > 0
      ? { ...gdeltReading([]), level: 0 }
      : gdeltReading(days);
    if (reading.level === null) return empty;

    const result: SourceComponent = {
      source: 'gdelt',
      level: reading.level,
      momentum: reading.momentum,
      fetchedAt: new Date().toISOString(),
      meta: {
        articles_pct_7d: Number(reading.meanPct.toFixed(4)),
        articles_pct_latest: reading.latestPct === null ? null : Number(reading.latestPct.toFixed(4)),
        latest_day: reading.latestDay,
        days: reading.days,
        resolution: body.query_details?.date_resolution ?? null,
      },
    };
    cache.set(key, { data: result, expiry: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    // A connection that never opened, or timed out: GDELT is overloaded.
    failed(term, (err as Error).name === 'TimeoutError' ? 'timeout' : 'connect');
    console.error(`[gdelt] query failed for "${term}": ${(err as Error).message}`);
    return empty;
  }
}
