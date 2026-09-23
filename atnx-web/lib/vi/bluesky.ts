// Bluesky post volume as a VI source. Post search needs a session (the
// public AppView answers 403 without one), so we log in with an app
// password and reuse the token.
//
// One paged fetch per phrase (the name and up to three aliases), latest
// first, over the last 24h. Posts are de-duplicated across phrases by
// URI, and the last-hour count is read off the same posts' timestamps,
// so a market costs (1 + aliases) requests per page rather than two per
// phrase.
import { clamp, type SourceComponent } from './score';

const PDS = 'https://bsky.social';
const USER_AGENT = 'ATNX/1.0 (attention-exchange; contact@atnx.app)';
const CACHE_TTL = 5 * 60 * 1000;
// Pages of 100 per phrase. Counting stops here; anything above is "a lot".
const MAX_PAGES = 5;
const COUNT_CAP = MAX_PAGES * 100;
const MOMENTUM_MIN_DAY = 24;
const MAX_PHRASES = 4;

const cache = new Map<string, { data: SourceComponent; expiry: number }>();

let session: { jwt: string; expiry: number } | null = null;
// One login in flight at a time. Bluesky rate-limits createSession per
// account, and failed logins count against a much smaller daily budget,
// so a batch of markets must never each start their own.
let login: Promise<string | null> | null = null;

export function blueskyConfigured(): boolean {
  return !!(process.env.BLUESKY_IDENTIFIER && process.env.BLUESKY_APP_PASSWORD);
}

// A handle needs its domain; a bare account name gets the default one.
function identifier(): string {
  const id = (process.env.BLUESKY_IDENTIFIER ?? '').trim().replace(/^@/, '');
  return id.includes('.') || id.includes('@') ? id : `${id}.bsky.social`;
}

async function getJwt(force = false): Promise<string | null> {
  if (!blueskyConfigured()) return null;
  if (!force && session && Date.now() < session.expiry) return session.jwt;
  if (!login) {
    login = (async () => {
      try {
        const res = await fetch(`${PDS}/xrpc/com.atproto.server.createSession`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'User-Agent': USER_AGENT },
          body: JSON.stringify({ identifier: identifier(), password: process.env.BLUESKY_APP_PASSWORD }),
          cache: 'no-store',
        });
        if (!res.ok) {
          console.error(`[bluesky] createSession ${res.status}: ${(await res.text()).slice(0, 120)}`);
          return null;
        }
        const body = (await res.json()) as { accessJwt: string };
        // Access tokens last ~2h; refresh well before that.
        session = { jwt: body.accessJwt, expiry: Date.now() + 90 * 60 * 1000 };
        return session.jwt;
      } finally {
        login = null;
      }
    })();
  }
  return login;
}

interface Post {
  uri: string;
  indexedAt: string;
  record?: { createdAt?: string };
}

// Posts matching one phrase since `since`, latest first, paging up to
// COUNT_CAP. Null on auth or transport failure so the caller can tell
// "unknown" from "zero".
async function fetchPosts(phrase: string, since: Date): Promise<Post[] | null> {
  let jwt = await getJwt();
  if (!jwt) return null;
  const posts: Post[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      q: `"${phrase.replace(/"/g, '')}"`,
      since: since.toISOString(),
      limit: '100',
      sort: 'latest',
    });
    if (cursor) params.set('cursor', cursor);
    const url = `${PDS}/xrpc/app.bsky.feed.searchPosts?${params}`;
    let res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}`, 'User-Agent': USER_AGENT }, cache: 'no-store' });
    if (res.status === 401 && page === 0) {
      jwt = await getJwt(true);
      if (!jwt) return null;
      res = await fetch(url, { headers: { Authorization: `Bearer ${jwt}`, 'User-Agent': USER_AGENT }, cache: 'no-store' });
    }
    if (!res.ok) {
      console.error(`[bluesky] searchPosts ${res.status} for "${phrase}"`);
      return null;
    }
    const body = (await res.json()) as { posts?: Post[]; cursor?: string };
    posts.push(...(body.posts ?? []));
    if (!body.cursor || (body.posts?.length ?? 0) < 100) break;
    cursor = body.cursor;
  }
  return posts;
}

// 24h post count to level, log scale:
//   0 -> 0, 1 -> 100, 10 -> 300, 100 -> 500, 1k -> 700, 10k -> 900
export function blueskyLevel(posts24h: number): number {
  if (posts24h <= 0) return 0;
  return clamp(Math.round(100 + 200 * Math.log10(posts24h)));
}

export async function fetchBlueskySignal(term: string, aliases: string[] = []): Promise<SourceComponent> {
  const phrases = [term, ...aliases]
    .map((p) => p.trim())
    .filter((p, i, all) => p.length >= 2 && all.findIndex((q) => q.toLowerCase() === p.toLowerCase()) === i)
    .slice(0, MAX_PHRASES);
  const key = phrases.join('|').toLowerCase();
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiry) return hit.data;

  const empty: SourceComponent = {
    source: 'bluesky',
    level: null,
    momentum: null,
    fetchedAt: new Date().toISOString(),
  };
  if (phrases.length === 0 || !blueskyConfigured()) return empty;

  try {
    const now = Date.now();
    const since = new Date(now - 24 * 3600 * 1000);
    const perPhrase = await Promise.all(phrases.map((p) => fetchPosts(p, since)));
    if (perPhrase.every((p) => p === null)) return empty;

    // Posts are assigned to the first phrase that returned them, so the
    // per-phrase counts are disjoint and sum to the de-duplicated total.
    const seen = new Set<string>();
    const hourAgo = now - 3600 * 1000;
    let day = 0;
    let hour = 0;
    let baselineRate = 0; // posts per hour, summed over phrases with a usable span
    let minSpan = Infinity;
    for (const posts of perPhrase) {
      let n = 0;
      let recent = 0;
      let oldest = now;
      for (const p of posts ?? []) {
        if (seen.has(p.uri)) continue;
        seen.add(p.uri);
        const t = Date.parse(p.record?.createdAt ?? p.indexedAt);
        n++;
        if (t >= hourAgo) recent++;
        if (t < oldest) oldest = t;
      }
      day += n;
      if (n === 0) continue;
      // The search index returns a truncated recent slice for busy phrases
      // whatever `since` says (Google: its newest ~150 posts, all inside
      // two hours, while "Google Search" spreads a few dozen over the day).
      // Each phrase's rate is therefore taken over the hours its own posts
      // span; one span across phrases read a busy market as a 10x spike
      // every hour. A span under two hours carries no baseline, and its
      // posts must then stay out of the hour count too, or the ratio
      // compares a busy phrase's hour against a quiet phrase's baseline.
      const spanHours = (now - oldest) / 3600_000;
      minSpan = Math.min(minSpan, spanHours);
      if (spanHours >= 2) {
        baselineRate += n / spanHours;
        hour += recent;
      }
    }
    // A phrase that hit the cap means the true count is higher.
    const capped = perPhrase.some((p) => (p?.length ?? 0) >= COUNT_CAP);

    // Hourly rate now vs the baseline rate, both over the phrases with a
    // real span. Below one post an hour most hours are empty and the ratio
    // is noise, so momentum also needs the day count to clear that bar.
    const momentum = day < MOMENTUM_MIN_DAY || baselineRate <= 0 ? null : hour / baselineRate;

    const result: SourceComponent = {
      source: 'bluesky',
      level: blueskyLevel(day),
      momentum,
      fetchedAt: new Date().toISOString(),
      meta: { posts_24h: capped ? `${day}+` : day, posts_1h: hour, phrases: phrases.length, span_h_min: Number.isFinite(minSpan) ? Number(minSpan.toFixed(1)) : null },
    };
    cache.set(key, { data: result, expiry: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.error(`[bluesky] query failed for "${term}":`, err);
    return empty;
  }
}
