// DexScreener as a VI source for token markets. Free, no auth, 300
// requests a minute. One search per market returns every trading pair
// whose token matches, each with 1h/6h/24h volume, so the reading needs
// no history of its own: the level is the day's traded volume and the
// momentum is the last six hours' rate against the day's mean. An hour
// is a handful of trades even on the deepest pairs and reads as noise.
//
// Only on-chain volume: the majors (BTC, DOGE) trade mostly on exchanges
// this source cannot see and read smaller than they are. The meme coins
// that become markets live on Solana and Base, where it sees them whole.
//
// Only pairs whose token symbol or name is the market's name or one of
// its aliases count; a search for "Doge" also returns every token with
// Doge in its name. The dispatcher asks this source about crypto
// markets alone. The fast path owns it.
import { clamp, type SourceComponent } from './score';

const API = 'https://api.dexscreener.com/latest/dex/search';
const USER_AGENT = 'ATNX/1.0 (attention-exchange; contact@atnx.app)';
const CACHE_TTL = 5 * 60 * 1000;
// A token trades on many chains and DEXes; the deepest pairs carry the
// real volume, the rest is dust and copies.
const MAX_PAIRS = 10;
// Below this much daily volume the rate is a few trades and the ratio
// is noise.
const MOMENTUM_MIN_VOLUME_USD = 10_000;

const cache = new Map<string, { data: SourceComponent; expiry: number }>();

interface Pair {
  chainId?: string;
  baseToken?: { address?: string; name?: string; symbol?: string };
  volume?: { h24?: number; h6?: number; h1?: number };
  liquidity?: { usd?: number };
  priceChange?: { h24?: number };
}

// 24h volume in USD to level, log scale:
//   $1k -> 200, $10k -> 350, $100k -> 500, $1M -> 650, $10M -> 800, $100M+ -> 950
export function dexLevel(volume24hUsd: number): number {
  if (volume24hUsd <= 0) return 0;
  return clamp(Math.round(150 * Math.log10(volume24hUsd) - 250));
}

// "$DOGE", "Dogecoin", "doge coin" all name the same token.
export function tokenKey(s: string): string {
  return s
    .toLowerCase()
    .replace(/^\$/, '')
    .replace(/[^a-z0-9]+/g, '')
    .replace(/(coin|token)$/, '');
}

// The pairs that are the market's token, deepest first. Pure.
export function matchingPairs(pairs: Pair[], names: string[]): Pair[] {
  const keys = new Set(names.map(tokenKey).filter((k) => k.length >= 2));
  return pairs
    .filter((p) => {
      const symbol = tokenKey(p.baseToken?.symbol ?? '');
      const name = tokenKey(p.baseToken?.name ?? '');
      return (symbol && keys.has(symbol)) || (name && keys.has(name));
    })
    .sort((a, b) => (b.liquidity?.usd ?? 0) - (a.liquidity?.usd ?? 0))
    .slice(0, MAX_PAIRS);
}

export function dexReading(pairs: Pair[]): { level: number; momentum: number | null; volume24h: number; volume6h: number; liquidity: number } {
  const volume24h = pairs.reduce((s, p) => s + (p.volume?.h24 ?? 0), 0);
  const volume6h = pairs.reduce((s, p) => s + (p.volume?.h6 ?? 0), 0);
  const liquidity = pairs.reduce((s, p) => s + (p.liquidity?.usd ?? 0), 0);
  const momentum = volume24h >= MOMENTUM_MIN_VOLUME_USD ? (volume6h * 4) / volume24h : null;
  return { level: dexLevel(volume24h), momentum, volume24h, volume6h, liquidity };
}

export async function fetchDexSignal(term: string, aliases: string[] = []): Promise<SourceComponent> {
  const names = [term, ...aliases].map((s) => s.trim()).filter(Boolean);
  const key = names.map(tokenKey).join('|');
  const hit = cache.get(key);
  if (hit && Date.now() < hit.expiry) return hit.data;

  const empty: SourceComponent = { source: 'dex', level: null, momentum: null, fetchedAt: new Date().toISOString() };
  if (names.length === 0) return empty;

  try {
    // One search for the name; the aliases only widen the match.
    const res = await fetch(`${API}?q=${encodeURIComponent(term.trim().replace(/^\$/, ''))}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      cache: 'no-store',
    });
    if (!res.ok) {
      console.error(`[dex] ${res.status} for "${term}"`);
      return empty;
    }
    const body = (await res.json()) as { pairs?: Pair[] | null };
    const pairs = matchingPairs(body.pairs ?? [], names);
    const reading = dexReading(pairs);
    const top = pairs[0];
    const result: SourceComponent = {
      source: 'dex',
      // No pair by that name is a real observation: there is no such token.
      level: pairs.length === 0 ? 0 : reading.level,
      momentum: pairs.length === 0 ? null : reading.momentum,
      fetchedAt: new Date().toISOString(),
      meta: {
        pairs: pairs.length,
        symbol: top?.baseToken?.symbol ?? null,
        chain: top?.chainId ?? null,
        volume_24h_usd: Math.round(reading.volume24h),
        volume_6h_usd: Math.round(reading.volume6h),
        liquidity_usd: Math.round(reading.liquidity),
        price_change_24h: top?.priceChange?.h24 ?? null,
      },
    };
    cache.set(key, { data: result, expiry: Date.now() + CACHE_TTL });
    return result;
  } catch (err) {
    console.error(`[dex] query failed for "${term}":`, err);
    return empty;
  }
}
