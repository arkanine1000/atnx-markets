// Names, units and flag copy for the VI sources, shared by the server-side
// explainer (lib/vi/explain.ts) and the admin's client components. Types
// and constants only, so client bundles can import it.
import type { SourceName } from './score';

export const SOURCE_LABEL: Record<SourceName, string> = {
  trends: 'Google Trends',
  bluesky: 'Bluesky',
  gdelt: 'News (GDELT)',
  wikipedia: 'Wikipedia',
  youtube: 'YouTube',
  hn: 'Hacker News',
  dex: 'DEX',
  x: 'X',
  tiktok: 'TikTok hashtag',
  tiktok_search: 'TikTok search',
  post: 'Captured posts',
};

// The unit of each source's raw reading, the number CALIBRATION converts.
export const SOURCE_UNIT: Record<SourceName, string> = {
  trends: '× the benchmark query',
  bluesky: 'posts a day',
  gdelt: '% of the week\'s news articles',
  wikipedia: 'pageviews a day',
  youtube: 'views a week',
  hn: 'hits a day',
  dex: 'USD traded a day',
  x: 'impressions a day',
  tiktok: 'views a day',
  tiktok_search: 'views a day',
  post: 'views a day',
};

export const SOURCE_ORDER: SourceName[] = ['trends', 'bluesky', 'wikipedia', 'gdelt', 'youtube', 'hn', 'x', 'tiktok', 'tiktok_search', 'post', 'dex'];

export type ViFlag = 'zero' | 'scoring' | 'dominant' | 'generic' | 'no_momentum' | 'stale' | 'catching_up';

export const FLAG_TEXT: Record<ViFlag, { short: string; long: string }> = {
  zero: { short: 'zero', long: 'The VI is 0: no source sees anything, or every reading is unknown.' },
  scoring: { short: 'scoring', long: 'A new market still on its first full pass; it goes live within two hours.' },
  dominant: { short: 'one source', long: 'One source carries more than 80% of the attention; the score follows that source alone.' },
  generic: { short: 'generic', long: 'The name is an everyday word, so Google Trends and Bluesky are not asked (the generic-term guard).' },
  no_momentum: { short: 'no momentum', long: 'No source has a baseline yet; momentum is neutral and the score is the level alone.' },
  stale: { short: 'stale', long: 'At least one source has not answered for longer than its cadence allows; its last reading stands in for up to 48 hours.' },
  catching_up: { short: 'catching up', long: 'The published VI is 25 or more points from what the stored readings compute; the 2-hour smoothing is still closing the gap.' },
};

export type Freshness = 'fresh' | 'late' | 'stale' | 'expiring' | 'unknown';

export const FRESHNESS_TEXT: Record<Freshness, string> = {
  fresh: 'fresh',
  late: 'late',
  stale: 'stale',
  expiring: 'expiring',
  unknown: 'no reading',
};
