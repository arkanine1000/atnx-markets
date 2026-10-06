// The markets page and /api/markets read the same URL parameters. One
// parser so a link the page builds is a query the API accepts.

import { CATEGORIES, isCategory, type Category } from './categories';

// The listing opens with this many markets and "Show more" adds this many.
export const PAGE_SIZE = 24;
// Twenty presses of "Show more". Past this a search or a filter serves
// better than a longer list, and each extra row costs a sparkline query.
export const MAX_LIMIT = PAGE_SIZE * 20;

// In the order the sort menu lists them. "closing" is ordered by virality
// in the database; the view then puts the live rounds first, soonest close
// on top, from the rounds it already holds.
export const SORTS = ['virality', 'closing', 'newest'] as const;
export type SortMode = (typeof SORTS)[number];
export const DEFAULT_SORT: SortMode = 'virality';

// The listing's two tabs: markets with a round live now, and every other
// market (a round waiting to open, or no rounds yet).
export const TABS = ['live', 'next'] as const;
export type MarketsTab = (typeof TABS)[number];

// A search term longer than this is not a market name.
export const MAX_SEARCH_LENGTH = 80;

export interface MarketsQuery {
  // How many markets to list from the top: a multiple of PAGE_SIZE.
  limit: number;
  sort: SortMode;
  // Free text matched against market names; empty means no filter.
  q: string;
  // Only markets filed under these, in CATEGORIES order; empty means all.
  categories: Category[];
  // Live or up next. Null leaves the choice to the page (Live when any
  // market is live) and, on /api/markets, lists every market.
  tab: MarketsTab | null;
}

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function read(params: ParamSource, key: string): string | null {
  if (params instanceof URLSearchParams) return params.get(key);
  const v = params[key];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

// Collapses whitespace and caps the length, so the memo key, the query and
// the input all see the same term.
export function normalizeSearch(raw: string | null | undefined): string {
  return (raw ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_SEARCH_LENGTH);
}

// Whole pages only, between one and MAX_LIMIT, so the memo sees a handful
// of keys rather than one per number someone types into the URL.
export function normalizeLimit(n: number): number {
  if (!Number.isFinite(n) || n < 1) return PAGE_SIZE;
  return Math.min(MAX_LIMIT, Math.ceil(n / PAGE_SIZE) * PAGE_SIZE);
}

// Known names only, deduplicated and in a fixed order so one selection has
// one URL. Every category ticked is the same as none.
export function normalizeCategories(raw: Iterable<string>): Category[] {
  const picked = new Set([...raw].filter(isCategory));
  if (picked.size === CATEGORIES.length) return [];
  return CATEGORIES.filter((c) => picked.has(c));
}

export function parseMarketsQuery(params: ParamSource): MarketsQuery {
  // An old ?sort=category link falls back to the default order.
  const rawSort = read(params, 'sort');
  const sort = (SORTS as readonly string[]).includes(rawSort ?? '')
    ? (rawSort as SortMode)
    : DEFAULT_SORT;
  // ?page=N is the pager this replaced; it opens with those N pages shown.
  const rawLimit = read(params, 'limit');
  const rawPage = read(params, 'page');
  const limit = normalizeLimit(
    rawLimit !== null
      ? Number.parseInt(rawLimit, 10)
      : rawPage !== null
        ? Number.parseInt(rawPage, 10) * PAGE_SIZE
        : PAGE_SIZE
  );
  const categories = normalizeCategories((read(params, 'cat') ?? '').split(','));
  const rawTab = read(params, 'tab');
  const tab = (TABS as readonly string[]).includes(rawTab ?? '') ? (rawTab as MarketsTab) : null;
  return { limit, sort, q: normalizeSearch(read(params, 'q')), categories, tab };
}

// Defaults are left out so the canonical listing is plain /app. A tab is
// written whenever one is picked: the default tab moves with the rounds.
export function marketsHref(
  { limit = PAGE_SIZE, sort = DEFAULT_SORT, q = '', categories = [], tab = null }: Partial<MarketsQuery>,
  base = '/app'
): string {
  const params = new URLSearchParams();
  if (tab) params.set('tab', tab);
  if (q) params.set('q', q);
  if (sort !== DEFAULT_SORT) params.set('sort', sort);
  if (limit > PAGE_SIZE) params.set('limit', String(limit));
  // Category names are plain words, so the list stays readable
  // (cat=memes,music) instead of URLSearchParams' %2C.
  const parts = [params.toString(), categories.length ? `cat=${categories.join(',')}` : '']
    .filter(Boolean)
    .join('&');
  return parts ? `${base}?${parts}` : base;
}
