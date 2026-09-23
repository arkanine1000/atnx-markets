// The markets page and /api/markets read the same two URL parameters. One
// parser so a link the page builds is a query the API accepts.

export const PAGE_SIZE = 24;

export const SORTS = ['virality', 'newest', 'category'] as const;
export type SortMode = (typeof SORTS)[number];
export const DEFAULT_SORT: SortMode = 'virality';

export interface MarketsQuery {
  page: number;
  sort: SortMode;
}

type ParamSource = URLSearchParams | Record<string, string | string[] | undefined>;

function read(params: ParamSource, key: string): string | null {
  if (params instanceof URLSearchParams) return params.get(key);
  const v = params[key];
  return Array.isArray(v) ? (v[0] ?? null) : (v ?? null);
}

export function parseMarketsQuery(params: ParamSource): MarketsQuery {
  const rawSort = read(params, 'sort');
  const sort = (SORTS as readonly string[]).includes(rawSort ?? '')
    ? (rawSort as SortMode)
    : DEFAULT_SORT;
  const rawPage = Number.parseInt(read(params, 'page') ?? '1', 10);
  const page = Number.isFinite(rawPage) && rawPage >= 1 ? rawPage : 1;
  return { page, sort };
}

// Defaults are left out so the canonical first page is plain /app.
export function marketsHref({ page, sort }: MarketsQuery, base = '/app'): string {
  const q = new URLSearchParams();
  if (sort !== DEFAULT_SORT) q.set('sort', sort);
  if (page > 1) q.set('page', String(page));
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}
