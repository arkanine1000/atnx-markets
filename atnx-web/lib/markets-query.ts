// The markets page and /api/markets read the same three URL parameters. One
// parser so a link the page builds is a query the API accepts.

export const PAGE_SIZE = 24;

export const SORTS = ['virality', 'newest', 'category'] as const;
export type SortMode = (typeof SORTS)[number];
export const DEFAULT_SORT: SortMode = 'virality';

// A search term longer than this is not a market name.
export const MAX_SEARCH_LENGTH = 80;

export interface MarketsQuery {
  page: number;
  sort: SortMode;
  // Free text matched against market names; empty means no filter.
  q: string;
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

export function parseMarketsQuery(params: ParamSource): MarketsQuery {
  const rawSort = read(params, 'sort');
  const sort = (SORTS as readonly string[]).includes(rawSort ?? '')
    ? (rawSort as SortMode)
    : DEFAULT_SORT;
  const rawPage = Number.parseInt(read(params, 'page') ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  return { page, sort, q: normalizeSearch(read(params, 'q')) };
}

// Defaults are left out so the canonical first page is plain /app.
export function marketsHref({ page, sort, q }: MarketsQuery, base = '/app'): string {
  const params = new URLSearchParams();
  if (q) params.set('q', q);
  if (sort !== DEFAULT_SORT) params.set('sort', sort);
  if (page > 1) params.set('page', String(page));
  const s = params.toString();
  return s ? `${base}?${s}` : base;
}
