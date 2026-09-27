// Finds a market's own X account, automatically, the way resolve.ts finds
// a creator's YouTube channel. The X source counts posts about a name; a
// person's or a brand's own posts rarely carry it, and for the biggest
// accounts those posts draw far more attention than the talk does (Elon
// Musk's own posts: about 20M impressions a day). The account is the
// missing signal, and nobody should have to type it in.
//
// Evidence, cheapest first: the capture's own URL (x.com/<handle>), a
// handle visible in the screenshot, Wikidata (P2002), and handles guessed
// from the name and aliases. Every candidate is checked on the vendor's
// user lookup ($0.00018 each): name, audience, agreement with the capture.
// Verified on Wikidata, or on two independent pieces of evidence when it
// also dwarfs every other candidate; anything less waits for an admin.
import { compact, screenHandles, type Evidence } from './resolve';
import { fetchArticleFacts, fetchWikidataValues } from '@/lib/vi/wikipedia';

const API = 'https://api.twitterapi.io/twitter/user/info';
// Below this an account is a namesake, a fan page or a placeholder.
export const MIN_FOLLOWERS = 10_000;
export const X_DWARF_RATIO = 5;
const MAX_LOOKUPS = 8;
export const USD_PER_LOOKUP = 0.00018;

export interface XAccount {
  id: string;
  userName: string; // lower case, no @
  name: string;
  followers: number;
  posts: number;
  verified: boolean;
}

export interface XCandidate {
  account: XAccount;
  evidence: Evidence[];
  nameMatch: boolean;
  fragmentMatch: boolean;
}

export interface XResolution {
  status: 'verified' | 'candidate' | 'none';
  review: boolean;
  best: XCandidate | null;
  candidates: XCandidate[];
  reason: string;
}

// Paths on x.com that are not profiles.
const RESERVED = new Set(['home', 'explore', 'search', 'i', 'intent', 'hashtag', 'settings', 'notifications', 'messages', 'compose', 'login', 'signup', 'share', 'tos', 'privacy', 'about', 'help']);

// What an X URL says about its account. Pure.
export function parseXUrl(raw: string | null): { handle: string } | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|mobile|m)\./, '');
  if (host !== 'x.com' && host !== 'twitter.com') return null;
  const first = u.pathname.split('/').filter(Boolean)[0];
  if (!first || RESERVED.has(first.toLowerCase())) return null;
  const handle = first.replace(/^@/, '').toLowerCase();
  return /^[a-z0-9_]{1,15}$/.test(handle) ? { handle } : null;
}

// Aliases written as handles ("@DolanDark", "elonmusk", "AndrewTate"):
// one token, letters, digits and underscores, up to 15. Pure.
export function handleAliases(aliases: string[]): string[] {
  const out: string[] = [];
  for (const a of aliases) {
    const t = a.trim();
    if (/\s/.test(t)) continue;
    const h = t.replace(/^@/, '').toLowerCase();
    if (/^[a-z0-9_]{3,15}$/.test(h) && !out.includes(h)) out.push(h);
  }
  return out;
}

// Handles worth one lookup each: the name run together and the aliases
// that already look like handles. Pure.
export function guessXHandles(name: string, aliases: string[] = []): string[] {
  const out: string[] = [];
  const push = (h: string) => {
    if (h.length >= 3 && h.length <= 15 && !out.includes(h)) out.push(h);
  };
  push(compact(name));
  for (const h of handleAliases(aliases)) push(h);
  return out.slice(0, MAX_LOOKUPS);
}

// Whether the account's display name or handle is the market's name or an
// alias (or its "official" variant). Pure.
export function xNameMatches(acc: XAccount, name: string, aliases: string[] = []): boolean {
  const names = [name, ...aliases.map((a) => a.replace(/^@/, ''))].map(compact).filter((s) => s.length >= 3);
  const own = [compact(acc.name), compact(acc.userName)].filter(Boolean);
  return own.some((o) => names.some((n) => o === n || o === `${n}official` || (n.length >= 6 && o.startsWith(n))));
}

// An alias that is exactly the handle ("@DolanDark", "elonmusk"). Pure.
export function xExactHandle(acc: XAccount, aliases: string[] = []): boolean {
  return handleAliases(aliases).includes(acc.userName);
}

export function decideX(candidates: XCandidate[]): XResolution {
  const eligible = candidates
    .filter((c) => c.nameMatch || c.fragmentMatch || c.evidence.includes('wikidata'))
    .sort((a, b) => b.account.followers - a.account.followers);
  const best = eligible[0] ?? null;
  if (!best) return { status: 'none', review: false, best: null, candidates, reason: 'no account matches the name' };
  const wiki = best.evidence.includes('wikidata');
  const independent = new Set(best.evidence).size;
  const big = best.account.followers >= MIN_FOLLOWERS;
  const next = eligible[1]?.account.followers ?? 0;
  const dwarfs = next === 0 || best.account.followers >= X_DWARF_RATIO * next;
  if (wiki) return { status: 'verified', review: false, best, candidates, reason: 'Wikidata lists the account' };
  if (independent >= 2 && big && dwarfs) return { status: 'verified', review: false, best, candidates, reason: `${independent} independent pieces of evidence, dwarfs the rest` };
  const why = [!big && 'audience below minimum', independent < 2 && 'only one piece of evidence', !dwarfs && 'a comparable account exists'].filter(Boolean).join(', ');
  return { status: 'candidate', review: big, best, candidates, reason: why };
}

export function xResolverConfigured(): boolean {
  return !!process.env.TWITTERAPI_IO_KEY;
}

async function lookup(userName: string): Promise<XAccount | null> {
  const res = await fetch(`${API}?${new URLSearchParams({ userName })}`, {
    headers: { 'X-API-Key': process.env.TWITTERAPI_IO_KEY ?? '', Accept: 'application/json' },
    cache: 'no-store',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) {
    console.error(`[creators:x] user/info ${res.status} for ${userName}`);
    return null;
  }
  const body = (await res.json()) as { status?: string; data?: { id?: string; userName?: string; name?: string; followers?: number; statusesCount?: number; isBlueVerified?: boolean; verifiedType?: string | null } };
  const d = body.data;
  if (body.status !== 'success' || !d?.id || !d.userName) return null;
  return {
    id: String(d.id),
    userName: d.userName.toLowerCase(),
    name: d.name ?? '',
    followers: Number(d.followers ?? 0),
    posts: Number(d.statusesCount ?? 0),
    verified: !!d.isBlueVerified || !!d.verifiedType,
  };
}

export interface ResolveXInput {
  name: string;
  aliases: string[];
  wikipediaTitle: string | null;
  captures: { source_url: string | null; ocr_text: string | null }[];
}

export async function resolveX(input: ResolveXInput): Promise<XResolution & { cost: { lookups: number } }> {
  const cost = { lookups: 0 };
  const found = new Map<string, { account: XAccount; evidence: Set<Evidence> }>();
  const tried = new Set<string>();
  const add = async (handle: string, ev: Evidence) => {
    const h = handle.toLowerCase();
    const hit = [...found.values()].find((f) => f.account.userName === h);
    if (hit) {
      hit.evidence.add(ev);
      return;
    }
    if (tried.has(h) || cost.lookups >= MAX_LOOKUPS) return;
    tried.add(h);
    cost.lookups++;
    const acc = await lookup(h);
    if (acc) found.set(acc.id, { account: acc, evidence: new Set([ev]) });
  };

  // 1. The capture's own URL.
  for (const c of input.captures) {
    const p = parseXUrl(c.source_url);
    if (p) await add(p.handle, 'capture_url');
  }
  // 2. Wikidata (P2002: X username).
  if (input.wikipediaTitle) {
    try {
      const facts = await fetchArticleFacts(input.wikipediaTitle);
      if (facts?.qid) for (const h of await fetchWikidataValues(facts.qid, 'P2002')) await add(h, 'wikidata');
    } catch (err) {
      console.error('[creators:x] wikidata', (err as Error).message);
    }
  }
  // 3. Full handles visible in screenshots.
  const fragments = input.captures.flatMap((c) => screenHandles(c.ocr_text));
  for (const f of fragments) if (/^[A-Za-z0-9_]{3,15}$/.test(f.raw)) await add(f.raw, 'screen_handle');
  // 4. Handles guessed from the name and aliases.
  for (const h of guessXHandles(input.name, input.aliases)) await add(h, 'handle_guess');

  const candidates: XCandidate[] = [...found.values()].map(({ account, evidence }) => {
    const fragmentMatch = fragments.some((f) => f.test(account.userName));
    const ev = [...evidence];
    if (fragmentMatch && !ev.includes('screen_handle')) ev.push('screen_handle');
    // An alias that is exactly the handle is a second, independent piece of
    // evidence beside a lookup that found it.
    if (xExactHandle(account, input.aliases) && !ev.includes('exact_name')) ev.push('exact_name');
    return { account, evidence: ev, nameMatch: xNameMatches(account, input.name, input.aliases), fragmentMatch };
  });
  return { ...decideX(candidates), cost };
}
