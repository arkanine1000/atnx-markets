"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  Suspense,
} from "react";
import { useSearchParams } from "next/navigation";
import { MarketCard, MarketRow } from "@/components/MarketCard";
import { FeaturedHero } from "@/components/FeaturedHero";
import { EmptyState, Segmented } from "@/components/ui";
import type { Capture } from "@/lib/store";

const POLL_MS = 5000;

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

type SortMode = "virality" | "newest" | "category";
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

interface MarketGroup {
  key: string; // marketId, or capture.id for orphan captures without a market yet
  latest: Capture;
  count: number;
}

// Collapse captures to one entry per market. The API returns captures in
// created_at DESC order, so the first time we see a marketId is the latest
// capture for that market (and the one carrying the history).
function groupByMarket(captures: Capture[]): MarketGroup[] {
  const groups = new Map<string, MarketGroup>();
  for (const capture of captures) {
    const key = capture.marketId ?? capture.id;
    const existing = groups.get(key);
    if (existing) existing.count += 1;
    else groups.set(key, { key, latest: capture, count: 1 });
  }
  return Array.from(groups.values());
}

function sortMarkets(groups: MarketGroup[], mode: SortMode): MarketGroup[] {
  const sorted = [...groups];
  switch (mode) {
    case "virality":
      return sorted.sort(
        (a, b) => b.latest.viralityScore - a.latest.viralityScore,
      );
    case "newest":
      return sorted.sort(
        (a, b) =>
          new Date(b.latest.timestamp).getTime() -
          new Date(a.latest.timestamp).getTime(),
      );
    case "category":
      return sorted.sort((a, b) => {
        const catA = a.latest.analysis.category || "zzz";
        const catB = b.latest.analysis.category || "zzz";
        if (catA !== catB) return catA.localeCompare(catB);
        return b.latest.viralityScore - a.latest.viralityScore;
      });
  }
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

export function MarketsView({ initialCaptures }: { initialCaptures: Capture[] }) {
  const [captures, setCaptures] = useState<Capture[]>(initialCaptures);
  const [sortMode, setSortMode] = useState<SortMode>("virality");
  const view = useSyncExternalStore<ViewMode>(subscribeView, readView, () => "grid");
  // Body of the last feed we rendered. A poll that returns the same bytes
  // is dropped before setState, so forty sparklines are not redrawn for
  // nothing every five seconds.
  const lastBody = useRef<string | null>(null);

  // Poll while the tab is visible; pick up straight away when it comes back.
  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    let cancelled = false;

    async function fetchCaptures() {
      try {
        const res = await fetch("/api/captures");
        const body = await res.text();
        if (cancelled || body === lastBody.current) return;
        const data = JSON.parse(body);
        if (Array.isArray(data.captures)) {
          lastBody.current = body;
          setCaptures(data.captures);
        }
      } catch {
        // Silently retry on next poll
      }
    }

    function schedule() {
      if (timer) clearInterval(timer);
      timer = null;
      if (document.visibilityState === "visible") {
        fetchCaptures();
        timer = setInterval(fetchCaptures, POLL_MS);
      }
    }

    schedule();
    document.addEventListener("visibilitychange", schedule);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
      document.removeEventListener("visibilitychange", schedule);
    };
  }, []);

  const groups = useMemo(() => groupByMarket(captures), [captures]);
  const sorted = useMemo(
    () => sortMarkets(groups, sortMode),
    [groups, sortMode],
  );

  return (
    <div>
      <Suspense fallback={null}>
        <ShareErrorBanner />
      </Suspense>

      <FeaturedHero captures={captures} />

      <div
        id="all-markets"
        className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3 mb-4 scroll-mt-24"
      >
        <div>
          <h2 className="text-lg sm:text-xl font-bold text-primary tracking-tight">
            All markets
          </h2>
          <p className="text-xs text-tertiary mt-1 flex items-center gap-2">
            <span className="relative inline-flex h-2 w-2">
              <span className="absolute inline-flex h-full w-full rounded-full bg-atnx-cyan opacity-60 animate-live-pulse" />
              <span className="relative inline-flex h-2 w-2 rounded-full bg-atnx-cyan" />
            </span>
            {groups.length} live {groups.length === 1 ? "market" : "markets"},
            refreshed every 5s
          </p>
        </div>

        <div className="flex items-center gap-2 flex-wrap">
          <Segmented
            ariaLabel="Sort markets"
            tone="accent"
            value={sortMode}
            onChange={setSortMode}
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

      {sorted.length === 0 ? (
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
          {sorted.map((g, i) => (
            <MarketCard
              key={g.key}
              capture={g.latest}
              captureCount={g.count}
              rank={i + 1}
              compact
            />
          ))}
        </div>
      ) : (
        <div>
          <div className="flex items-center gap-3 px-3 py-1.5 text-[11px] uppercase tracking-wider text-tertiary">
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
            {sorted.map((g, i) => (
              <MarketRow
                key={g.key}
                capture={g.latest}
                captureCount={g.count}
                rank={i + 1}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
