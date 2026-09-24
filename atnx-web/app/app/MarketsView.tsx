"use client";

import {
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
  Suspense,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { MarketCard, MarketRow } from "@/components/MarketCard";
import { FeaturedHero } from "@/components/FeaturedHero";
import { EmptyState, Pager, Segmented } from "@/components/ui";
import { startPolling } from "@/lib/poll";
import { marketsHref, type SortMode } from "@/lib/markets-query";
import type { MarketsPage } from "@/lib/store";

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

export function MarketsView({
  initial,
  sort,
  page,
  q,
}: {
  initial: MarketsPage;
  sort: SortMode;
  page: number;
  // The search term from the nav's search box; empty lists everything.
  q: string;
}) {
  const router = useRouter();
  const [data, setData] = useState<MarketsPage>(initial);
  const view = useSyncExternalStore<ViewMode>(subscribeView, readView, () => "grid");
  // Body of the last page we rendered. A poll that returns the same bytes
  // is dropped before setState, so two dozen sparklines are not redrawn
  // for nothing every thirty seconds.
  const lastBody = useRef<string | null>(null);

  // Poll the open page while the tab is visible, backing off while the API
  // is failing. The first fetch waits a full interval: the page arrived
  // with its data, unless the server render failed, in which case fetch now.
  useEffect(() => {
    async function fetchPage() {
      const res = await fetch(`/api/markets${marketsHref({ page, sort, q }, "")}`);
      if (!res.ok) throw new Error(`markets ${res.status}`);
      const body = await res.text();
      if (body === lastBody.current) return;
      const next = JSON.parse(body) as MarketsPage;
      if (Array.isArray(next.items)) {
        lastBody.current = body;
        setData(next);
      }
    }
    return startPolling(fetchPage, {
      intervalMs: POLL_MS,
      immediate: initial.items.length === 0,
    });
    // initial is the server render; it does not change for this key.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, sort, q]);

  // A page turn keeps the scroll (the links pass scroll={false}) and lands
  // on the listing rather than re-showing the hero.
  const mounted = useRef(false);
  useEffect(() => {
    if (!mounted.current) {
      mounted.current = true;
      return;
    }
    document.getElementById("all-markets")?.scrollIntoView({ block: "start" });
  }, [page, sort]);

  const setSort = (next: SortMode) =>
    router.replace(marketsHref({ sort: next, page: 1, q }), { scroll: false });

  const { items, featured, total, pageSize } = data;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const offset = (page - 1) * pageSize;
  const pastEnd = items.length === 0 && total > 0;

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
        <div>
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
          <p className="text-xs text-tertiary mt-1 flex items-center gap-2">
            {q ? (
              <>
                {total} {total === 1 ? "market" : "markets"} match
                <Link
                  href={marketsHref({ sort, page: 1, q: "" })}
                  className="text-secondary hover:text-primary underline underline-offset-2"
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
                {total} live {total === 1 ? "market" : "markets"}, refreshed
                every 30s
              </>
            )}
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Segmented
            ariaLabel="Sort markets"
            tone="accent"
            itemClassName="w-24"
            value={sort}
            onChange={setSort}
            options={[
              { value: "virality", label: "Virality" },
              { value: "newest", label: "Newest" },
              { value: "category", label: "Category" },
            ]}
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

      {pastEnd ? (
        <EmptyState
          title="Nothing on this page"
          body={`There are ${pages} ${pages === 1 ? "page" : "pages"} of markets.`}
          action={
            <Link
              href={marketsHref({ sort, page: 1, q })}
              className="btn-magenta inline-flex items-center rounded-full px-4 py-2 text-xs font-bold"
            >
              Back to the first page
            </Link>
          }
        />
      ) : items.length === 0 && q ? (
        <EmptyState
          title="No markets match"
          body={`Nothing is named like “${q}”. Try a shorter term, or create the market.`}
          action={
            <div className="flex items-center gap-2">
              <Link
                href={marketsHref({ sort, page: 1, q: "" })}
                className="inline-flex items-center rounded-full border border-surface bg-surface hover-lift px-4 py-2 text-xs font-bold text-primary"
              >
                Clear search
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
              rank={offset + i + 1}
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
                rank={offset + i + 1}
              />
            ))}
          </div>
        </div>
      )}

      {pages > 1 && (
        <div className="mt-6 flex justify-center">
          <Pager
            page={page}
            pages={pages}
            href={(p) => marketsHref({ sort, page: p, q })}
          />
        </div>
      )}
    </div>
  );
}
