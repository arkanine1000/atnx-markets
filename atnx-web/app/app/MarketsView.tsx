"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  useTransition,
  Suspense,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { MarketCard, MarketRow } from "@/components/MarketCard";
import { FeaturedHero } from "@/components/FeaturedHero";
import { CategoryFilter } from "@/components/CategoryFilter";
import { EmptyState, Segmented } from "@/components/ui";
import { startPolling } from "@/lib/poll";
import {
  MAX_LIMIT,
  PAGE_SIZE,
  SORTS,
  marketsHref,
  type MarketsQuery,
  type MarketsTab,
  type SortMode,
} from "@/lib/markets-query";
import { CATEGORY_LABELS, type Category } from "@/lib/categories";
import type { Capture, MarketsPage } from "@/lib/store";
import type { RoundsMap } from "@/lib/bm/round-badges";

// A new VI point lands every five minutes; thirty seconds is plenty to
// catch a fresh capture. Behind it the server memoizes the feed for 15 s,
// so several tabs cost one database read per window.
const POLL_MS = 30_000;

function ShareErrorBanner() {
  const searchParams = useSearchParams();
  const shareError = searchParams.get("shareError");
  const [dismissed, setDismissed] = useState(false);
  if (!shareError || dismissed) return null;
  return (
    <div className="mb-4 flex items-start gap-3 rounded-xl border border-atnx-magenta/40 bg-atnx-magenta/10 px-3 py-2 text-xs text-atnx-magenta">
      <span className="font-bold shrink-0">SHARE FAILED:</span>
      <span className="flex-1 break-words">{shareError}</span>
      <button
        onClick={() => setDismissed(true)}
        className="text-atnx-magenta/70 hover:text-atnx-magenta shrink-0 cursor-pointer"
        aria-label="Dismiss"
      >
        {"✕"}
      </button>
    </div>
  );
}

type ViewMode = "grid" | "list";
const VIEW_KEY = "atnx:markets:view";

// The grid/list choice lives in localStorage. Read through
// useSyncExternalStore so the server render and the first client render
// agree (grid), and the saved value applies right after hydration.
const viewListeners = new Set<() => void>();
function subscribeView(listener: () => void) {
  viewListeners.add(listener);
  window.addEventListener("storage", listener);
  return () => {
    viewListeners.delete(listener);
    window.removeEventListener("storage", listener);
  };
}
function readView(): ViewMode {
  try {
    const saved = window.localStorage.getItem(VIEW_KEY);
    return saved === "list" ? "list" : "grid";
  } catch {
    return "grid";
  }
}
function writeView(v: ViewMode) {
  try {
    window.localStorage.setItem(VIEW_KEY, v);
  } catch {
    /* private mode etc. */
  }
  for (const l of viewListeners) l();
}

const GridIcon = (
  <svg
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="currentColor"
    aria-hidden="true"
  >
    <rect x="1" y="1" width="6" height="6" rx="1.5" />
    <rect x="9" y="1" width="6" height="6" rx="1.5" />
    <rect x="1" y="9" width="6" height="6" rx="1.5" />
    <rect x="9" y="9" width="6" height="6" rx="1.5" />
  </svg>
);
const ListIcon = (
  <svg
    viewBox="0 0 16 16"
    width="14"
    height="14"
    fill="currentColor"
    aria-hidden="true"
  >
    <rect x="1" y="2" width="14" height="3" rx="1.5" />
    <rect x="1" y="6.5" width="14" height="3" rx="1.5" />
    <rect x="1" y="11" width="14" height="3" rx="1.5" />
  </svg>
);

// Bounds of the live bounded market per atnx market id, for the tile badge.
export type BoundsMap = Record<string, { lower: number; upper: number }>;

// A tabbed listing from /api/markets carries the round badges with it.
type Listing = MarketsPage & { rounds?: RoundsMap };

const SORT_LABELS: Record<SortMode, string> = {
  virality: "Virality",
  closing: "Closing soonest",
  newest: "Newest",
};
// On phones the control shrinks to an icon and a word.
const SORT_SHORT: Record<SortMode, string> = {
  virality: "Virality",
  closing: "Closing",
  newest: "Newest",
};

const SortIcon = (
  <svg
    viewBox="0 0 16 16"
    width="13"
    height="13"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M5 13V3M2.5 5.5 5 3l2.5 2.5M11 3v10M8.5 10.5 11 13l2.5-2.5" />
  </svg>
);

const Chevron = (
  <svg
    viewBox="0 0 12 12"
    width="10"
    height="10"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.8"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M2.5 4.5 6 8l3.5-3.5" />
  </svg>
);

// The order, as a small pill at the end of the tab row: "Sort Virality",
// and on phones the icon and the word. A native select sits over it, so
// the menu is the platform's own (a sheet on phones).
function SortControl({
  value,
  onChange,
}: {
  value: SortMode;
  onChange: (next: SortMode) => void;
}) {
  return (
    <label className="relative inline-flex shrink-0 items-center gap-1.5 rounded-full border border-surface bg-surface hover-lift pl-3 pr-2.5 py-2 text-xs font-bold whitespace-nowrap cursor-pointer text-secondary focus-within:border-atnx-magenta/50">
      <span className="sm:hidden">{SortIcon}</span>
      <span className="hidden sm:inline font-normal text-tertiary">Sort</span>
      <span className="text-primary">
        <span className="sm:hidden">{SORT_SHORT[value]}</span>
        <span className="hidden sm:inline">{SORT_LABELS[value]}</span>
      </span>
      {Chevron}
      <select
        aria-label="Sort markets"
        value={value}
        onChange={(e) => onChange(e.target.value as SortMode)}
        className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
      >
        {SORTS.map((s) => (
          <option key={s} value={s}>
            {SORT_LABELS[s]}
          </option>
        ))}
      </select>
    </label>
  );
}

function TabLabel({ label, count, pulse }: { label: string; count?: number; pulse?: boolean }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      {pulse && (
        <span className="relative inline-flex h-1.5 w-1.5" aria-hidden="true">
          <span className="absolute inline-flex h-full w-full rounded-full bg-atnx-cyan opacity-60 animate-live-pulse" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-atnx-cyan" />
        </span>
      )}
      {label}
      {count !== undefined && (
        <span className="font-mono text-[10px] tabular-nums opacity-60">{count}</span>
      )}
    </span>
  );
}

// "Closing soonest": live rounds by their close, the rest after them in
// the order the server sent (virality). Only the markets loaded are
// ordered; on the Live tab that is all of them until there are more than
// a page of live rounds.
function byClose(items: Capture[], rounds: RoundsMap): Capture[] {
  const closeOf = (c: Capture) => {
    const r = c.marketId ? rounds[c.marketId] : undefined;
    return r?.state === "live" && r.closeAt ? Date.parse(r.closeAt) : Infinity;
  };
  return items
    .map((c, i) => ({ c, i, at: closeOf(c) }))
    .sort((a, b) => (a.at === b.at ? a.i - b.i : a.at < b.at ? -1 : 1))
    .map(({ c }) => c);
}

export function MarketsView({
  initial,
  query,
  bounded = {},
  rounds = {},
}: {
  initial: Listing;
  bounded?: BoundsMap;
  rounds?: RoundsMap;
  // What the server rendered: order, search term (from the nav's search
  // box; empty lists everything), category filter and how many to show.
  query: MarketsQuery;
}) {
  const router = useRouter();
  const [data, setData] = useState<Listing>(initial);
  // The order, tab and filter as last clicked. They lead the URL while its
  // navigation is in flight, so a second tick builds on the first. A tab
  // of null is the page's default (Live when any market is live), which
  // the listing reports back as `tab`.
  const [sort, setSortState] = useState(query.sort);
  const [tab, setTabState] = useState<MarketsTab | null>(query.tab);
  const [categories, setCategories] = useState<Category[]>(query.categories);
  // True while "Show more" is the navigation in flight: the list keeps its
  // full opacity then, since nothing on it is about to change.
  const [more, setMore] = useState(false);
  const [pending, startTransition] = useTransition();
  const view = useSyncExternalStore<ViewMode>(subscribeView, readView, () => "grid");
  // Body of the last listing we rendered. A poll that returns the same
  // bytes is dropped before setState, so two dozen sparklines are not
  // redrawn for nothing every thirty seconds.
  const lastBody = useRef<string | null>(null);

  // Not keyed on the query, so the filter's menu survives a tick: when the
  // server sends a new listing (a sort, filter or search), start from it.
  const [rendered, setRendered] = useState(initial);
  if (initial !== rendered) {
    setRendered(initial);
    setData(initial);
    setSortState(query.sort);
    setTabState(query.tab);
    setCategories(query.categories);
    setMore(false);
  }

  const limit = query.limit;
  const catsKey = query.categories.join(",");
  // The poll asks for the tab the server picked, so a default of Live
  // stays Live (and the API sends the counts and badges with it).
  const pollTab = query.tab ?? rendered.tab ?? null;

  // Poll the listing while the tab is visible, backing off while the API
  // is failing. The first fetch waits a full interval: the page arrived
  // with its data, unless the server render failed, in which case fetch now.
  useEffect(() => {
    let live = true;
    async function fetchListing() {
      const res = await fetch(`/api/markets${marketsHref({ ...query, tab: pollTab }, "")}`);
      if (!res.ok) throw new Error(`markets ${res.status}`);
      const body = await res.text();
      // A tick that set off before the query or limit changed is stale.
      if (!live || body === lastBody.current) return;
      const next = JSON.parse(body) as Listing;
      if (Array.isArray(next.items)) {
        lastBody.current = body;
        setData(next);
      }
    }
    const stop = startPolling(fetchListing, {
      intervalMs: POLL_MS,
      immediate: data.items.length === 0,
    });
    return () => {
      live = false;
      stop();
    };
    // query is rebuilt every render; these are what it is made of.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [limit, query.sort, query.q, catsKey, pollTab]);

  const navigate = (next: Partial<MarketsQuery>) =>
    startTransition(() =>
      router.replace(marketsHref({ sort, q: query.q, categories, tab, ...next }), {
        scroll: false,
      }),
    );

  // One more page of the same listing, as a router navigation rather than
  // a fetch plus history.replaceState: a manual replaceState keeps the
  // router's tree for the shorter listing, so the back button restored the
  // first page from cache and the scroll position with it. A navigation
  // records the longer listing in the history entry, and going back
  // restores it, at its length, from the router cache.
  const showMore = () => {
    setMore(true);
    navigate({ limit: Math.min(MAX_LIMIT, limit + PAGE_SIZE) });
  };

  // A new order, tab or filter starts again from the top of the list.
  const setSort = (next: SortMode) => {
    setSortState(next);
    navigate({ sort: next });
  };
  const setTab = (next: MarketsTab) => {
    setTabState(next);
    navigate({ tab: next });
  };
  const setFilter = (next: Category[]) => {
    setCategories(next);
    navigate({ categories: next });
  };

  const { featured, total, categoryCounts, tabCounts } = data;
  const roundsNow = data.rounds ?? rounds;
  const items = sort === "closing" ? byClose(data.items, roundsNow) : data.items;
  // The tab as clicked, else the one the server listed.
  const shownTab: MarketsTab = tab ?? data.tab ?? "live";
  const otherTab: MarketsTab = shownTab === "live" ? "next" : "live";
  const otherCount = tabCounts?.[otherTab] ?? 0;
  // Markets under the search and filter, both tabs together.
  const all = tabCounts ? tabCounts.live + tabCounts.next : total;
  const q = query.q;
  const filtered = query.categories.length > 0;
  const filterNames = query.categories.map((c) => CATEGORY_LABELS[c]).join(", ");
  const canShowMore = items.length < total && limit < MAX_LIMIT;

  // Clears the search, keeps the order, tab and filter.
  const clearSearch = marketsHref({ sort, categories, tab });
  const clearFilter = marketsHref({ sort, q, tab });

  return (
    <div>
      <Suspense fallback={null}>
        <ShareErrorBanner />
      </Suspense>

      {/* A search is about the listing; the hero would push it below the
          fold and repeat markets that may not match. */}
      {!q && <FeaturedHero captures={featured} />}

      <div
        id="all-markets"
        className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-4 scroll-mt-24"
      >
        <div className="min-w-0">
          <h2 className="font-display text-lg sm:text-xl font-bold text-primary tracking-tight">
            {q ? (
              <>
                Results for{" "}
                <span className="text-atnx-cyan light:text-atnx-cyan-light">
                  &ldquo;{q}&rdquo;
                </span>
              </>
            ) : (
              "All markets"
            )}
          </h2>
          <p className="text-xs text-tertiary mt-1 flex items-center gap-2 flex-wrap">
            {q ? (
              <>
                {all} {all === 1 ? "market" : "markets"} match
                {filtered && <> in {filterNames}</>}
                <Link
                  href={clearSearch}
                  className="text-secondary link-quiet underline underline-offset-2"
                >
                  Clear search
                </Link>
              </>
            ) : (
              <>
                <span className="relative inline-flex h-2 w-2">
                  <span className="absolute inline-flex h-full w-full rounded-full bg-atnx-cyan opacity-60 animate-live-pulse" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-atnx-cyan" />
                </span>
                {all} {all === 1 ? "market" : "markets"}
                {filtered ? <> in {filterNames}</> : ", refreshed every 30s"}
                {filtered && (
                  <Link
                    href={clearFilter}
                    scroll={false}
                    className="text-secondary link-quiet underline underline-offset-2"
                  >
                    Clear filter
                  </Link>
                )}
              </>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <CategoryFilter
            selected={categories}
            counts={categoryCounts}
            onChange={setFilter}
          />
          <Segmented
            ariaLabel="View"
            value={view}
            onChange={writeView}
            options={[
              { value: "grid", label: GridIcon, title: "Grid" },
              { value: "list", label: ListIcon, title: "List" },
            ]}
          />
        </div>
      </div>

      {/* Live: a round is open now. Up next: a round waiting to open, or
          none yet. The order is a small control at the end of the row. */}
      <div className="flex items-center justify-between gap-2 mb-4">
        <Segmented
          ariaLabel="Markets by round"
          value={shownTab}
          onChange={setTab}
          options={[
            {
              value: "live",
              label: <TabLabel label="Live" count={tabCounts?.live} pulse={(tabCounts?.live ?? 0) > 0} />,
            },
            {
              value: "next",
              label: <TabLabel label="Up next" count={tabCounts?.next} />,
            },
          ]}
        />
        <SortControl value={sort} onChange={setSort} />
      </div>

      <div
        aria-busy={pending}
        className={`transition-opacity duration-200 ${pending && !more ? "opacity-50" : ""}`}
      >
        {items.length === 0 && otherCount > 0 ? (
          <EmptyState
            title={shownTab === "live" ? "Nothing is live right now" : "Every market here is live"}
            body={
              shownTab === "live"
                ? `No market${q || filtered ? " here" : ""} has a round open. ${otherCount} ${otherCount === 1 ? "is" : "are"} up next.`
                : `Each market${q || filtered ? " here" : ""} has a round open right now.`
            }
            action={
              <button
                type="button"
                onClick={() => setTab(otherTab)}
                className="inline-flex items-center rounded-full border border-surface bg-surface hover-lift px-4 py-2 text-xs font-bold text-primary cursor-pointer"
              >
                {shownTab === "live" ? "See up next" : "See live"}
              </button>
            }
          />
        ) : items.length === 0 && (q || filtered) ? (
          <EmptyState
            title="No markets match"
            body={
              q
                ? `Nothing${filtered ? ` in ${filterNames}` : ""} is named like “${q}”. Try a shorter term, or create the market.`
                : `Nothing is filed under ${filterNames} yet.`
            }
            action={
              <div className="flex items-center justify-center gap-2 flex-wrap">
                <Link
                  href={q ? clearSearch : clearFilter}
                  scroll={false}
                  className="inline-flex items-center rounded-full border border-surface bg-surface hover-lift px-4 py-2 text-xs font-bold text-primary"
                >
                  {q ? "Clear search" : "Clear filter"}
                </Link>
                <Link
                  href="/app/submit"
                  className="btn-magenta inline-flex items-center rounded-full px-4 py-2 text-xs font-bold"
                >
                  Create a market
                </Link>
              </div>
            }
          />
        ) : items.length === 0 ? (
          <EmptyState
            title="No markets yet"
            body={
              <>
                Capture anything on the web with the ATNX extension
                <span className="mx-1 rounded border border-surface bg-elevated px-1 py-0.5 text-[10px] text-secondary">
                  Ctrl+Shift+X
                </span>
                and it shows up here as a tradeable market.
              </>
            }
          />
        ) : view === "grid" ? (
          <div className="grid grid-cols-1 xs:grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {items.map((c, i) => (
              <MarketCard
                key={c.marketId ?? c.id}
                capture={c}
                captureCount={c.captureCount ?? 1}
                rank={i + 1}
                bounds={c.marketId ? bounded[c.marketId] : undefined}
                round={c.marketId ? roundsNow[c.marketId] : undefined}
                compact
              />
            ))}
          </div>
        ) : (
          <div>
            <div className="flex items-center gap-3 px-3 py-1.5 text-[11px] font-mono uppercase tracking-wider text-tertiary">
              <span className="w-6 text-right shrink-0">#</span>
              <span className="w-10 shrink-0" />
              <span className="flex-1">Market</span>
              <span className="hidden sm:block w-28 shrink-0 text-center">
                History
              </span>
              <span className="hidden xs:block sm:w-20 shrink-0 text-right">
                24h
              </span>
              <span className="w-14 sm:w-16 text-center shrink-0">VI</span>
              <span className="w-3 shrink-0" />
            </div>
            <div className="space-y-1.5">
              {items.map((c, i) => (
                <MarketRow
                  key={c.marketId ?? c.id}
                  capture={c}
                  captureCount={c.captureCount ?? 1}
                  rank={i + 1}
                  bounds={c.marketId ? bounded[c.marketId] : undefined}
                  round={c.marketId ? roundsNow[c.marketId] : undefined}
                />
              ))}
            </div>
          </div>
        )}
      </div>

      {items.length > 0 && items.length < total && (
        <div className="mt-6 flex flex-col items-center gap-2">
          {canShowMore && (
            <button
              type="button"
              onClick={showMore}
              disabled={pending}
              className="inline-flex items-center gap-2 rounded-full border border-surface bg-surface hover-lift px-5 py-2.5 text-xs font-bold text-primary cursor-pointer disabled:cursor-wait disabled:opacity-60"
            >
              {more && pending ? "Loading…" : "Show more"}
            </button>
          )}
          <p className="text-[11px] font-mono tabular-nums text-tertiary" aria-live="polite">
            {canShowMore ? (
              <>
                Showing {items.length} of {total}
              </>
            ) : (
              <>
                Showing the top {items.length} of {total}. Search or filter to
                find the rest.
              </>
            )}
          </p>
        </div>
      )}
    </div>
  );
}
