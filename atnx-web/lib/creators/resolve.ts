// Finds a creator market's own YouTube channel, automatically. Every VI
// source counts other people talking about a name; a creator's audience is
// on their own uploads, which rarely carry their name, so a mid-tier
// creator reads zero everywhere. Their channel is the missing signal, and
// nobody should have to type it in.
//
// Evidence, cheapest first: the capture's own URL and the handle visible in
// the screenshot, Wikidata, handles guessed from the name and aliases
// (channels.list forHandle, 1 unit each), and only then a channel search
// (the scarce search.list bucket). Every candidate is checked on
// channels.list: name, audience, agreement with what the capture showed.
// A channel is verified only on Wikidata, or on two independent pieces of
// evidence when it also dwarfs every other candidate; anything less stays
// a candidate for review and is never scored.
import { fetchArticleFacts, fetchWikidataValues } from '@/lib/vi/wikipedia';

const API = 'https://www.googleapis.com/youtube/v3';
// Below this a channel is a namesake, a fan page or an empty placeholder
// (@forrestsautoreviews: "Forrest Jones", 30 subscribers, no videos).
export const MIN_SUBSCRIBERS = 10_000;
// The verified channel must be this many times bigger than the next one.
export const DWARF_RATIO = 5;

export type Evidence = 'wikidata' | 'capture_url' | 'screen_handle' | 'handle_guess' | 'name_search';

export interface Channel {
  id: string;
  title: string;
  handle: string | null; // customUrl without the @, lower case
  subscribers: number | null; // null when hidden
  views: number;
  videos: number;
  description: string;
}

export interface Candidate {
  channel: Channel;
  evidence: Evidence[];
  nameMatch: boolean;
  fragmentMatch: boolean;
}

export interface Resolution {
  status: 'verified' | 'candidate' | 'none';
  best: Candidate | null;
  candidates: Candidate[];
  reason: string;
}

export interface CaptureEvidence {
  source_url: string | null;
  ocr_text: string | null;
}

// Letters and digits only, lower case: "Forrest's Auto Reviews" and
// "@ForrestsAutoReviews" meet at "forrestsautoreviews". Pure.
export function compact(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]/g, '');
}

// What a platform URL says about its channel. Pure.
export function parseYoutubeUrl(raw: string | null): { videoId?: string; handle?: string; channelId?: string } | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  const host = u.hostname.replace(/^(www|m|music)\./, '');
  if (host === 'youtu.be') {
    const id = u.pathname.slice(1).split('/')[0];
    return id ? { videoId: id } : null;
  }
  if (host !== 'youtube.com') return null;
  const parts = u.pathname.split('/').filter(Boolean);
  if (u.searchParams.get('v')) return { videoId: u.searchParams.get('v')! };
  if (parts[0]?.startsWith('@')) return { handle: parts[0].slice(1).toLowerCase() };
  if (parts[0] === 'channel' && parts[1]?.startsWith('UC')) return { channelId: parts[1] };
  if (['shorts', 'live', 'embed', 'v'].includes(parts[0] ?? '') && parts[1]) return { videoId: parts[1] };
  return null;
}

// Handles visible in a screenshot, possibly cut short by the app
// ("@forre...official"). Returned as a matcher over full handles. Pure.
export function screenHandles(ocr: string | null): { raw: string; test: (handle: string) => boolean }[] {
  if (!ocr) return [];
  const out: { raw: string; test: (h: string) => boolean }[] = [];
  for (const m of ocr.matchAll(/@([A-Za-z0-9_.]+(?:(?:\.\.\.|…)[A-Za-z0-9_.]+)?)/g)) {
    const raw = m[1];
    const cut = raw.split(/\.\.\.|…/);
    if (cut.length === 2) {
      const [head, tail] = cut.map((p) => p.toLowerCase().replace(/\.+$/, ''));
      if (head.length + tail.length < 4) continue;
      out.push({ raw, test: (h) => h.startsWith(head) && h.endsWith(tail) && h.length > head.length + tail.length });
    } else {
      const full = raw.toLowerCase().replace(/\.+$/, '');
      if (full.length >= 3) out.push({ raw, test: (h) => h === full });
    }
  }
  return out;
}

// Handles worth one forHandle lookup each, from the name and aliases:
// the name run together, and each with the "official" suffix creators use
// when the plain one was taken. Pure.
export function guessHandles(name: string, aliases: string[] = []): string[] {
  const out: string[] = [];
  const push = (h: string) => {
    if (h.length >= 3 && h.length <= 30 && !out.includes(h)) out.push(h);
  };
  for (const s of [name, ...aliases]) {
    const c = compact(s);
    push(c);
    push(`${c}official`);
  }
  return out.slice(0, 8);
}

// Whether a channel's name or handle is the market's name or an alias. Pure.
export function nameMatches(ch: Channel, name: string, aliases: string[] = []): boolean {
  const names = [name, ...aliases].map(compact).filter((s) => s.length >= 3);
  const own = [compact(ch.title), ch.handle ? compact(ch.handle) : ''].filter(Boolean);
  return own.some((o) => names.some((n) => o === n || o === `${n}official` || (n.length >= 6 && o.startsWith(n))));
}

// The verdict over all candidates. Pure.
export function decide(candidates: Candidate[]): Resolution {
  const eligible = candidates
    .filter((c) => c.nameMatch || c.fragmentMatch || c.evidence.includes('wikidata'))
    .sort((a, b) => audience(b.channel) - audience(a.channel));
  const best = eligible[0] ?? null;
  if (!best) return { status: 'none', best: null, candidates, reason: 'no channel matches the name' };
  const wiki = best.evidence.includes('wikidata');
  const independent = new Set(best.evidence).size;
  const big = audience(best.channel) >= MIN_SUBSCRIBERS;
  const next = eligible[1] ? audience(eligible[1].channel) : 0;
  const dwarfs = next === 0 || audience(best.channel) >= DWARF_RATIO * next;
  if (wiki) return { status: 'verified', best, candidates, reason: 'Wikidata lists the channel' };
  if (independent >= 2 && big && dwarfs) return { status: 'verified', best, candidates, reason: `${independent} independent pieces of evidence, dwarfs the rest` };
  const why = [!big && 'audience below minimum', independent < 2 && 'only one piece of evidence', !dwarfs && 'a comparable channel exists'].filter(Boolean).join(', ');
  return { status: 'candidate', best, candidates, reason: why };
}

function audience(ch: Channel): number {
  return ch.subscribers ?? Math.round(ch.views / 1000);
}

async function api<T>(path: string, params: Record<string, string>): Promise<T | null> {
  const res = await fetch(`${API}/${path}?${new URLSearchParams({ ...params, key: process.env.YOUTUBE_API_KEY ?? '' })}`, { cache: 'no-store' });
  if (!res.ok) {
    console.error(`[creators] ${path} ${res.status}: ${(await res.text()).slice(0, 120)}`);
    return null;
  }
  return (await res.json()) as T;
}

interface ChannelItem {
  id: string;
  snippet?: { title?: string; customUrl?: string; description?: string };
  statistics?: { subscriberCount?: string; hiddenSubscriberCount?: boolean; viewCount?: string; videoCount?: string };
}

function toChannel(it: ChannelItem): Channel {
  const st = it.statistics ?? {};
  return {
    id: it.id,
    title: it.snippet?.title ?? '',
    handle: it.snippet?.customUrl ? it.snippet.customUrl.replace(/^@/, '').toLowerCase() : null,
    subscribers: st.hiddenSubscriberCount ? null : Number(st.subscriberCount ?? 0),
    views: Number(st.viewCount ?? 0),
    videos: Number(st.videoCount ?? 0),
    description: it.snippet?.description ?? '',
  };
}

async function channelsById(ids: string[]): Promise<Channel[]> {
  if (ids.length === 0) return [];
  const body = await api<{ items?: ChannelItem[] }>('channels', { part: 'snippet,statistics', id: ids.slice(0, 50).join(',') });
  return (body?.items ?? []).map(toChannel);
}

async function channelByHandle(handle: string): Promise<Channel | null> {
  const body = await api<{ items?: ChannelItem[] }>('channels', { part: 'snippet,statistics', forHandle: `@${handle}` });
  return body?.items?.[0] ? toChannel(body.items[0]) : null;
}

export interface ResolveInput {
  name: string;
  aliases: string[];
  wikipediaTitle: string | null;
  captures: CaptureEvidence[];
  // A channel search costs one of the day's 100; off unless asked for.
  allowSearch?: boolean;
}

export interface ResolveCost {
  units: number;
  searches: number;
}

export async function resolveYoutube(input: ResolveInput): Promise<Resolution & { cost: ResolveCost }> {
  const cost: ResolveCost = { units: 0, searches: 0 };
  const found = new Map<string, { channel: Channel; evidence: Set<Evidence> }>();
  const add = (ch: Channel | null, ev: Evidence) => {
    if (!ch) return;
    const hit = found.get(ch.id) ?? { channel: ch, evidence: new Set<Evidence>() };
    hit.evidence.add(ev);
    found.set(ch.id, hit);
  };
  const fragments = input.captures.flatMap((c) => screenHandles(c.ocr_text));

  // 1. The capture's own URL.
  const videoIds: string[] = [];
  for (const c of input.captures) {
    const p = parseYoutubeUrl(c.source_url);
    if (p?.handle) {
      cost.units++;
      add(await channelByHandle(p.handle), 'capture_url');
    } else if (p?.channelId) {
      cost.units++;
      for (const ch of await channelsById([p.channelId])) add(ch, 'capture_url');
    } else if (p?.videoId) videoIds.push(p.videoId);
  }
  if (videoIds.length) {
    cost.units += 2;
    const v = await api<{ items?: { snippet?: { channelId?: string } }[] }>('videos', { part: 'snippet', id: videoIds.slice(0, 50).join(',') });
    const ids = [...new Set((v?.items ?? []).map((i) => i.snippet?.channelId).filter((x): x is string => !!x))];
    for (const ch of await channelsById(ids)) add(ch, 'capture_url');
  }

  // 2. Wikidata.
  if (input.wikipediaTitle) {
    try {
      const facts = await fetchArticleFacts(input.wikipediaTitle);
      if (facts?.qid) {
        const ids = await fetchWikidataValues(facts.qid, 'P2397');
        if (ids.length) {
          cost.units++;
          for (const ch of await channelsById(ids)) add(ch, 'wikidata');
        }
      }
    } catch (err) {
      console.error('[creators] wikidata', (err as Error).message);
    }
  }

  // 3. Handles guessed from the name and aliases.
  for (const h of guessHandles(input.name, input.aliases)) {
    if ([...found.values()].some((f) => f.channel.handle === h)) continue;
    cost.units++;
    add(await channelByHandle(h), 'handle_guess');
  }

  // 4. A channel search, only when nothing matched the name.
  const anyMatch = [...found.values()].some((f) => nameMatches(f.channel, input.name, input.aliases));
  if (!anyMatch && input.allowSearch) {
    cost.searches++;
    const q = [input.name, ...input.aliases.filter((a) => /\s/.test(a)).slice(0, 1)].map((s) => `"${s.replace(/"/g, '')}"`).join('|');
    const s = await api<{ items?: { id?: { channelId?: string } }[] }>('search', { part: 'id', type: 'channel', q, maxResults: '5' });
    const ids = (s?.items ?? []).map((i) => i.id?.channelId).filter((x): x is string => !!x);
    cost.units++;
    for (const ch of await channelsById(ids)) add(ch, 'name_search');
  }

  const candidates: Candidate[] = [...found.values()].map(({ channel, evidence }) => {
    const fragmentMatch = !!channel.handle && fragments.some((f) => f.test(channel.handle!));
    const ev = [...evidence];
    if (fragmentMatch) ev.push('screen_handle');
    return { channel, evidence: ev, nameMatch: nameMatches(channel, input.name, input.aliases), fragmentMatch };
  });
  return { ...decide(candidates), cost };
}
