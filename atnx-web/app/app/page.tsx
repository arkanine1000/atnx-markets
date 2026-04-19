"use client";

import { useEffect, useState, useMemo, Suspense } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Nav } from "@/components/Nav";
import { TrendSparkline } from "@/components/Trading";
import { mock24hChange } from "@/lib/capture-view";

function ShareErrorBanner() {
  const searchParams = useSearchParams();
  const shareError = searchParams.get("shareError");
  const [dismissed, setDismissed] = useState(false);
  if (!shareError || dismissed) return null;
  return (
    <div className="mb-4 flex items-start gap-3 rounded border border-atnx-magenta/40 bg-atnx-magenta/10 px-3 py-2 text-xs text-atnx-magenta">
      <span className="font-bold shrink-0">SHARE FAILED:</span>
      <span className="flex-1 break-words">{shareError}</span>
      <button
        onClick={() => setDismissed(true)}
        className="text-atnx-magenta/70 hover:text-atnx-magenta shrink-0 cursor-pointer"
        aria-label="Dismiss"
      >
        {"\u2715"}
      </button>
    </div>
  );
}

interface TrendsData {
  term: string;
  dataPoints: { date: string; value: number }[];
  viralityScore: number;
  peakValue: number;
  currentValue: number;
  trend: string;
  fetchedAt: string;
}

interface Capture {
  id: string;
  marketId: string | null;
  timestamp: string;
  pageUrl: string;
  pageTitle: string;
  screenshot: string;
  analysis: {
    type?: string;
    name?: string;
    description?: string;
    category?: string;
    platforms_detected?: string[];
    metrics_detected?: Record<string, string | number>;
    sentiment?: string;
    virality_signals?: string;
    raw_text?: string;
    error?: string;
    raw_response?: string;
    parse_error?: boolean;
  };
  trends: TrendsData | null;
  viralityScore: number;
}

type SortMode = "virality" | "newest" | "category";

function CaptureRow({
  capture,
  captureCount,
  rank,
}: {
  capture: Capture;
  captureCount: number;
  rank: number;
}) {
  const { analysis, trends, viralityScore, marketId } = capture;
  const change24h = useMemo(
    () => mock24hChange(marketId ?? capture.id, viralityScore),
    [marketId, capture.id, viralityScore]
  );
  const changeArrow = change24h >= 0 ? "\u25B2" : "\u25BC";
  const changeArrowColor = change24h >= 0 ? "#00D4FF" : "#FF00E5";

  const content = (
    <div className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-2.5">
      <span className="text-xs text-tertiary font-mono w-4 sm:w-5 text-right shrink-0">
        {rank}
      </span>

      <img
        src={capture.screenshot}
        alt=""
        className="w-9 h-9 sm:w-10 sm:h-10 object-cover rounded border border-surface shrink-0"
      />

      <div className="min-w-0 flex-1">
        <div className="text-sm font-bold text-primary truncate flex items-center gap-2">
          <span className="truncate">{analysis.name || "Untitled"}</span>
          {captureCount > 1 && (
            <span className="shrink-0 text-[10px] font-bold uppercase tracking-wider bg-atnx-magenta/15 text-atnx-magenta border border-atnx-magenta/30 px-1.5 py-0.5 rounded">
              {captureCount} captures
            </span>
          )}
          {!marketId && (
            <span className="shrink-0 text-[10px] uppercase tracking-wider text-tertiary">
              {"processing\u2026"}
            </span>
          )}
        </div>
        <div className="text-xs text-tertiary truncate">
          {analysis.category || "\u2014"}
        </div>
      </div>

      <div className="w-24 shrink-0 hidden sm:block">
        <TrendSparkline
          dataPoints={trends?.dataPoints ?? []}
          color="#00D4FF"
          height={32}
        />
      </div>

      <div className="shrink-0 w-14 sm:w-20 text-right flex items-center justify-end gap-1">
        <span
          style={{ color: changeArrowColor }}
          className="text-[10px] sm:text-xs"
        >
          {changeArrow}
        </span>
        <span className="text-[11px] sm:text-xs font-bold font-mono text-atnx-yellow">
          {Math.abs(change24h)}%
        </span>
      </div>

      <div className="shrink-0 text-base sm:text-lg font-bold font-mono tabular-nums px-1.5 sm:px-2 py-0.5 rounded w-12 sm:w-16 text-center text-atnx-yellow bg-atnx-yellow/10 border border-atnx-yellow/25">
        {viralityScore}
      </div>

      <span className="text-secondary text-xs shrink-0 w-3 sm:w-4 text-center">
        {marketId ? "\u203A" : ""}
      </span>
    </div>
  );

  const shellClass =
    "bg-surface border border-surface rounded-lg overflow-hidden transition-colors";

  if (!marketId) {
    return (
      <div className={`${shellClass} opacity-70`} aria-disabled="true">
        {content}
      </div>
    );
  }

  return (
    <Link
      href={`/app/markets/${marketId}`}
      className={`block cursor-pointer hover:border-atnx-cyan/30 hover:bg-dark-elevated/30 ${shellClass}`}
    >
      {content}
    </Link>
  );
}

interface MarketGroup {
  key: string; // marketId, or capture.id for orphan captures without a market yet
  latest: Capture;
  count: number;
}

// Collapse captures to one entry per market. The API returns captures in
// created_at DESC order, so the first time we see a marketId is the latest
// capture for that market.
function groupByMarket(captures: Capture[]): MarketGroup[] {
  const groups = new Map<string, MarketGroup>();
  for (const capture of captures) {
    const key = capture.marketId ?? capture.id;
    const existing = groups.get(key);
    if (existing) {
      existing.count += 1;
    } else {
      groups.set(key, { key, latest: capture, count: 1 });
    }
  }
  return Array.from(groups.values());
}

function sortMarkets(groups: MarketGroup[], mode: SortMode): MarketGroup[] {
  const sorted = [...groups];
  switch (mode) {
    case "virality":
      return sorted.sort(
        (a, b) => b.latest.viralityScore - a.latest.viralityScore
      );
    case "newest":
      return sorted.sort(
        (a, b) =>
          new Date(b.latest.timestamp).getTime() -
          new Date(a.latest.timestamp).getTime()
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

export default function Home() {
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>("virality");

  useEffect(() => {
    async function fetchCaptures() {
      try {
        const res = await fetch("/api/captures");
        const data = await res.json();
        setCaptures(data.captures);
      } catch {
        // Silently retry on next poll
      }
    }

    fetchCaptures();
    const interval = setInterval(fetchCaptures, 5000);
    return () => clearInterval(interval);
  }, []);

  const groups = useMemo(() => groupByMarket(captures), [captures]);
  const sorted = useMemo(
    () => sortMarkets(groups, sortMode),
    [groups, sortMode]
  );

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 w-full">
      <Nav />

      <Suspense fallback={null}>
        <ShareErrorBanner />
      </Suspense>

      {/* Sort controls — magenta active state */}
      {captures.length > 0 && (
        <div className="flex items-center gap-2 mb-4 text-xs">
          <span className="text-secondary">Sort by:</span>
          {(["virality", "newest", "category"] as SortMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setSortMode(mode)}
              className={`px-3 py-1.5 rounded border cursor-pointer transition-colors ${
                sortMode === mode
                  ? "bg-atnx-magenta text-black border-atnx-magenta font-bold"
                  : "bg-surface text-secondary border-surface hover:border-atnx-magenta/50"
              }`}
            >
              {mode === "virality"
                ? "Virality"
                : mode === "newest"
                  ? "Newest"
                  : "Category"}
            </button>
          ))}
        </div>
      )}

      {/* Column header */}
      {captures.length > 0 && (
        <div className="flex items-center gap-2 sm:gap-3 px-2 sm:px-3 py-1.5 text-[11px] sm:text-xs text-tertiary mb-1">
          <span className="w-4 sm:w-5 text-right shrink-0">#</span>
          <span className="w-9 sm:w-10 shrink-0" />
          <span className="flex-1">Name</span>
          <span className="w-24 shrink-0 hidden sm:block text-center">
            7d Chart
          </span>
          <span className="w-14 sm:w-20 text-right shrink-0">24h</span>
          <span className="w-12 sm:w-16 text-center shrink-0">Score</span>
          <span className="w-3 sm:w-4 shrink-0" />
        </div>
      )}

      {/* Capture list */}
      {captures.length === 0 ? (
        <div className="text-center py-20">
          <div className="text-atnx-magenta text-4xl mb-4">⌘</div>
          <p className="text-secondary text-sm">No captures yet.</p>
          <p className="text-tertiary text-xs mt-2">
            Use the ATNX Chrome extension (Ctrl+Shift+X) to capture content.
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {sorted.map((group, i) => (
            <CaptureRow
              key={group.key}
              capture={group.latest}
              captureCount={group.count}
              rank={i + 1}
            />
          ))}
        </div>
      )}
    </div>
  );
}
