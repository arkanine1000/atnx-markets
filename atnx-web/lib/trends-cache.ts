const cache = new Map<string, { data: TrendsResultCached; expiry: number }>();
const CACHE_TTL = 5 * 60 * 1000; // 5 minute cache

interface TrendsResultCached {
  term: string;
  dataPoints: { date: string; value: number }[];
  viralityScore: number;
  peakValue: number;
  currentValue: number;
  trend: string;
  fetchedAt: string;
}

export function getCached(term: string): TrendsResultCached | null {
  const entry = cache.get(term.toLowerCase());
  if (entry && Date.now() < entry.expiry) return entry.data;
  return null;
}

export function setCache(term: string, data: TrendsResultCached) {
  cache.set(term.toLowerCase(), { data, expiry: Date.now() + CACHE_TTL });
}
