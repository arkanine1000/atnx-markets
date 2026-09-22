// Bluesky post volume as a VI source. Post search needs a session (the
// public AppView answers 403 without one), so we log in with an app
// password and reuse the token. Two counts per term: posts in the last 24h
// (level) and in the last hour (momentum against the 24h hourly rate).
import { clamp, type SourceComponent } from './score';

const PDS = 'https://bsky.social';
const USER_AGENT = 'ATNX/1.0 (attention-exchange; contact@atnx.app)';
const CACHE_TTL = 5 * 60 * 1000;
// Pages of 100. Counting stops here; anything above is "a lot".
const MAX_PAGES = 5;
const COUNT_CAP = MAX_PAGES * 100;
const MOMENTUM_MIN_DAY = 24;

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

// Counts matching posts since `since`, paging up to COUNT_CAP. Returns
// null on auth or transport failure so the caller can tell "unknown"
// from "zero".
async function countPosts(term: string, since: Date): Promise<number | null> {
  let jwt = await getJwt();
  if (!jwt) return null;
  let total = 0;
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const params = new URLSearchParams({
      q: `"${term.replace(/"/g, '')}"`,
      since: since.toISOString(),
      limit: '100',
      sort: 'latest',
    });
    if (cursor) params.set('cursor', cursor);
    let res = await fetch(`${PDS}/xrpc/app.bsky.feed.searchPosts?${params}`, {
      headers: { Authorization: `Bearer ${jwt}`, 'User-Agent': USER_AGENT },
      cache: 'no-store',
    });
    if (res.status === 401 && page === 0) {
      jwt = await getJwt(true);
      if (!jwt) return null;
      res = await fetch(`${PDS}/xrpc/app.bsky.feed.searchPosts?${params}`, {
        headers: { Authorization: `Bearer ${jwt}`, 'User-Agent': USER_AGENT },
        cache: 'no-store',
      });
    }
    if (!res.ok) {
      console.error(`[bluesky] searchPosts ${res.status} for "${term}"`);
      return null;
    }
    const body = (await res.json()) as { posts?: unknown[]; cursor?: string; hitsTotal?: number };
    // Some AppViews report the full hit count directly.
    if (page === 0 && typeof body.hitsTotal === 'number') return body.hitsTotal;
    total += body.posts?.length ?? 0;
    if (!body.cursor || (body.posts?.length ?? 0) < 100) break;
    cursor = body.cursor;
  }
  return total;
}

// 24h post count to level, log scale:
//   0 -> 0, 1 -> 100, 10 -> 300, 100 -> 500, 1k -> 700, 10k -> 900
export function blueskyLevel(posts24h: number): number {
  if (posts24h <= 0) return 0;
  return clamp(Math.round(100 + 200 * Math.log10(posts24h)));
}

export async function fetchBlueskySignal(term: string): Promise<SourceComponent> {
  const key = term.toLowerCase().trim();
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiry) return hit.data;

  const empty: SourceComponent = {
    source: 'bluesky',
    level: null,
    momentum: null,
    fetchedAt: new Date().toISOString(),
  };
  if (key.length < 2 || !blueskyConfigured()) return empty;

  try {
    const now = Date.now();
    const [day, hour] = await Promise.all([
      countPosts(term, new Date(now - 24 * 3600 * 1000)),
      countPosts(term, new Date(now - 3600 * 1000)),
    ]);
    if (day === null) return empty;

    // Hourly rate now vs the average hourly rate over the day. Below one
    // post an hour most hours are empty and the ratio is noise, so only
    // report momentum once the day count clears that bar. With the 24h
    // count capped, the ratio is a floor when the cap is hit.
    const hourlyMean = day / 24;
    const momentum = hour === null || day < MOMENTUM_MIN_DAY ? null : hour / hourlyMean;

    const result: SourceComponent = {
      source: 'bluesky',
      level: blueskyLevel(day),
      momentum,
      fetchedAt: new Date().toISOString(),
      meta: { posts_24h: day >= COUNT_CAP ? `${COUNT_CAP}+` : day, posts_1h: hour },
    };
    cache.set(key, { data: result, expiry: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.error(`[bluesky] query failed for "${term}":`, err);
    return empty;
  }
}
