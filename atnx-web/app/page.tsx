"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
import { useDemoContext } from "@/context/DemoContext";
import { Nav } from "@/components/Nav";
import {
  TrendSparkline,
  getScoreColor,
  getTrendIndicator,
  TradeModal,
  DemoToast,
} from "@/components/Trading";

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

function timeAgo(timestamp: string): string {
  const seconds = Math.floor(
    (Date.now() - new Date(timestamp).getTime()) / 1000
  );
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function sentimentColor(sentiment?: string): string {
  switch (sentiment) {
    case "positive":
      return "text-green-400";
    case "negative":
      return "text-red-400";
    case "mixed":
      return "text-yellow-400";
    default:
      return "text-atnx-text-muted";
  }
}

// Generate a deterministic mock 24h change from the capture id
function mock24hChange(id: string, score: number): number {
  let hash = 0;
  for (let i = 0; i < id.length; i++) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  // Bias toward positive for higher scores
  const base = ((hash % 600) - 250) / 10; // range roughly -25 to +35
  const bias = score > 400 ? 5 : score > 200 ? 0 : -3;
  return Math.round((base + bias) * 10) / 10;
}

function CaptureCard({
  capture,
  rank,
  isExpanded,
  onToggle,
  onTrade,
}: {
  capture: Capture;
  rank: number;
  isExpanded: boolean;
  onToggle: () => void;
  onTrade: (capture: Capture) => void;
}) {
  const [showRaw, setShowRaw] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const { analysis, trends, viralityScore } = capture;
  const scoreColor = getScoreColor(viralityScore);
  const trendInfo = getTrendIndicator(trends?.trend);
  const change24h = useMemo(
    () => mock24hChange(capture.id, viralityScore),
    [capture.id, viralityScore]
  );
  const changeColor = change24h >= 0 ? "#00FF66" : "#FF0040";

  const { positions } = useDemoContext();
  const openPos = positions.find(
    (p) => p.captureId === capture.id || p.name === analysis.name
  );

  return (
    <div className="bg-atnx-surface border border-atnx-border rounded-lg overflow-hidden transition-all duration-200">
      {/* Compact row — always visible */}
      <div
        onClick={onToggle}
        className="flex items-center gap-3 px-3 py-2.5 cursor-pointer hover:bg-atnx-bg/30 transition-colors"
      >
        {/* Rank */}
        <span className="text-xs text-atnx-text-muted font-mono w-5 text-right shrink-0">
          {rank}
        </span>

        {/* Thumbnail */}
        <img
          src={`data:image/png;base64,${capture.screenshot}`}
          alt=""
          className="w-10 h-10 object-cover rounded border border-atnx-border shrink-0"
        />

        {/* Name */}
        <div className="min-w-0 flex-1">
          <div className="text-sm font-bold text-atnx-text truncate">
            {analysis.name || "Untitled"}
          </div>
          <div className="text-xs text-atnx-text-muted truncate">
            {analysis.category || "—"}
          </div>
        </div>

        {/* Mini sparkline */}
        <div className="w-24 shrink-0 hidden sm:block">
          <TrendSparkline
            dataPoints={trends?.dataPoints ?? []}
            color={scoreColor}
            height={32}
          />
        </div>

        {/* 24h Change */}
        <div className="shrink-0 w-16 text-right">
          <span
            className="text-xs font-bold font-mono"
            style={{ color: changeColor }}
          >
            {change24h >= 0 ? "+" : ""}
            {change24h}%
          </span>
        </div>

        {/* Score */}
        <div
          className="shrink-0 text-lg font-bold font-mono tabular-nums px-2 py-0.5 rounded w-16 text-center"
          style={{
            color: scoreColor,
            backgroundColor: `${scoreColor}15`,
            borderWidth: 1,
            borderColor: `${scoreColor}40`,
          }}
        >
          {viralityScore}
        </div>

        {/* Expand chevron */}
        <span className="text-atnx-text-muted text-xs shrink-0 w-4 text-center">
          {isExpanded ? "\u25B4" : "\u25BE"}
        </span>
      </div>

      {/* Expanded details */}
      {isExpanded && (
        <div className="border-t border-atnx-border px-4 py-4 space-y-3">
          <div className="flex gap-4">
            {/* Larger thumbnail */}
            <div className="shrink-0">
              <img
                src={`data:image/png;base64,${capture.screenshot}`}
                alt="Capture"
                className="w-36 h-28 object-cover rounded border border-atnx-border"
              />
            </div>

            <div className="flex-1 min-w-0 space-y-2">
              {/* Score header */}
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2 flex-wrap">
                  {analysis.type && (
                    <span className="text-xs uppercase tracking-wider bg-atnx-bg px-2 py-0.5 rounded text-atnx-green border border-atnx-green/30">
                      {analysis.type}
                    </span>
                  )}
                  <span className="font-bold text-atnx-green text-sm">
                    {analysis.name}
                  </span>
                </div>
                <div className="flex items-center gap-2 shrink-0">
                  <span
                    className="text-xs font-bold"
                    style={{ color: scoreColor }}
                  >
                    {trendInfo.icon} {trendInfo.label}
                  </span>
                  <span
                    className="text-xs font-mono font-bold"
                    style={{ color: changeColor }}
                  >
                    24h: {change24h >= 0 ? "+" : ""}
                    {change24h}%
                  </span>
                </div>
              </div>

              {/* Sparkline with entry marker */}
              <div className="max-w-sm">
                <TrendSparkline
                  dataPoints={trends?.dataPoints ?? []}
                  color={scoreColor}
                  height={60}
                  entryIndex={openPos?.entryIndex}
                  positionType={openPos?.type}
                />
              </div>

              {analysis.error ? (
                <div className="text-red-400 text-sm">
                  Error: {analysis.error}
                </div>
              ) : (
                <>
                  <div className="flex gap-4 text-xs text-atnx-text-muted flex-wrap">
                    {analysis.category && (
                      <span>CATEGORY: {analysis.category}</span>
                    )}
                    {analysis.sentiment && (
                      <span className={sentimentColor(analysis.sentiment)}>
                        SENTIMENT: {analysis.sentiment}
                      </span>
                    )}
                    {trends && (
                      <span>
                        PEAK: {trends.peakValue} | NOW: {trends.currentValue}
                      </span>
                    )}
                  </div>

                  {analysis.description && (
                    <p className="text-sm text-atnx-text leading-relaxed">
                      &ldquo;{analysis.description}&rdquo;
                    </p>
                  )}

                  {analysis.virality_signals && (
                    <p className="text-xs text-atnx-text-muted">
                      Virality: {analysis.virality_signals}
                    </p>
                  )}

                  {analysis.platforms_detected &&
                    analysis.platforms_detected.length > 0 && (
                      <div className="flex gap-1.5 flex-wrap">
                        {analysis.platforms_detected.map((p) => (
                          <span
                            key={p}
                            className="text-xs bg-atnx-bg px-1.5 py-0.5 rounded text-atnx-text-muted"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    )}
                </>
              )}

              <div className="flex items-center justify-between pt-1">
                <div className="flex gap-4 text-xs text-atnx-text-muted">
                  <span>SOURCE: {new URL(capture.pageUrl).hostname}</span>
                  <span>CAPTURED: {timeAgo(capture.timestamp)}</span>
                </div>

                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onTrade(capture);
                  }}
                  className="text-xs px-4 py-2 rounded border border-atnx-green text-atnx-green hover:bg-atnx-green hover:text-atnx-bg cursor-pointer transition-colors font-bold"
                >
                  Trade This
                </button>
              </div>

              {/* Collapsible sub-sections */}
              <div className="flex gap-3 text-xs pt-1">
                {analysis.metrics_detected &&
                  Object.keys(analysis.metrics_detected).length > 0 && (
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        setShowMetrics(!showMetrics);
                      }}
                      className="text-atnx-green hover:text-atnx-green-dark cursor-pointer"
                    >
                      {showMetrics ? "\u25BE" : "\u25B8"} Detected metrics
                    </button>
                  )}
                {analysis.raw_text && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      setShowRaw(!showRaw);
                    }}
                    className="text-atnx-green hover:text-atnx-green-dark cursor-pointer"
                  >
                    {showRaw ? "\u25BE" : "\u25B8"} Raw text
                  </button>
                )}
              </div>

              {showMetrics && analysis.metrics_detected && (
                <div className="bg-atnx-bg rounded p-2 text-xs space-y-0.5">
                  {Object.entries(analysis.metrics_detected).map(([k, v]) => (
                    <div key={k}>
                      <span className="text-atnx-text-muted">{k}:</span>{" "}
                      <span className="text-atnx-text">{String(v)}</span>
                    </div>
                  ))}
                </div>
              )}

              {showRaw && analysis.raw_text && (
                <div className="bg-atnx-bg rounded p-2 text-xs text-atnx-text-muted whitespace-pre-wrap break-words max-h-40 overflow-auto">
                  {analysis.raw_text}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function sortCaptures(captures: Capture[], mode: SortMode): Capture[] {
  const sorted = [...captures];
  switch (mode) {
    case "virality":
      return sorted.sort((a, b) => b.viralityScore - a.viralityScore);
    case "newest":
      return sorted.sort(
        (a, b) =>
          new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      );
    case "category":
      return sorted.sort((a, b) => {
        const catA = a.analysis.category || "zzz";
        const catB = b.analysis.category || "zzz";
        if (catA !== catB) return catA.localeCompare(catB);
        return b.viralityScore - a.viralityScore;
      });
  }
}

export default function Home() {
  const [captures, setCaptures] = useState<Capture[]>([]);
  const [sortMode, setSortMode] = useState<SortMode>("virality");
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [tradingCapture, setTradingCapture] = useState<Capture | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    detail: string;
    type: "long" | "short";
  } | null>(null);

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

  const handleTradeClose = useCallback(() => {
    if (tradingCapture) {
      setToast({
        message: "Position Opened",
        detail: `${tradingCapture.analysis.name} @ ${tradingCapture.viralityScore}`,
        type: "long",
      });
    }
    setTradingCapture(null);
  }, [tradingCapture]);

  const sorted = sortCaptures(captures, sortMode);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 w-full">
      <Nav captureCount={captures.length} />

      {/* Sort controls */}
      {captures.length > 0 && (
        <div className="flex items-center gap-2 mb-4 text-xs">
          <span className="text-atnx-text-muted">Sort by:</span>
          {(["virality", "newest", "category"] as SortMode[]).map((mode) => (
            <button
              key={mode}
              onClick={() => setSortMode(mode)}
              className={`px-3 py-1.5 rounded border cursor-pointer transition-colors ${
                sortMode === mode
                  ? "bg-atnx-green text-atnx-bg border-atnx-green font-bold"
                  : "bg-atnx-surface text-atnx-text-muted border-atnx-border hover:border-atnx-green/50"
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
        <div className="flex items-center gap-3 px-3 py-1.5 text-xs text-atnx-text-muted mb-1">
          <span className="w-5 text-right shrink-0">#</span>
          <span className="w-10 shrink-0" />
          <span className="flex-1">Name</span>
          <span className="w-24 shrink-0 hidden sm:block text-center">
            7d Chart
          </span>
          <span className="w-16 text-right shrink-0">24h</span>
          <span className="w-16 text-center shrink-0">Score</span>
          <span className="w-4 shrink-0" />
        </div>
      )}

      {/* Capture list */}
      {captures.length === 0 ? (
        <div className="text-center py-20">
          <div className="text-atnx-green text-4xl mb-4">⌘</div>
          <p className="text-atnx-text-muted text-sm">No captures yet.</p>
          <p className="text-atnx-text-muted text-xs mt-2">
            Use the ATNX Chrome extension (Ctrl+Shift+X) to capture content.
          </p>
        </div>
      ) : (
        <div className="space-y-1">
          {sorted.map((capture, i) => (
            <CaptureCard
              key={capture.id}
              capture={capture}
              rank={i + 1}
              isExpanded={expandedId === capture.id}
              onToggle={() =>
                setExpandedId(expandedId === capture.id ? null : capture.id)
              }
              onTrade={setTradingCapture}
            />
          ))}
        </div>
      )}

      {/* Trade modal */}
      {tradingCapture && (
        <TradeModal capture={tradingCapture} onClose={handleTradeClose} />
      )}

      {/* Toast */}
      {toast && (
        <DemoToast
          message={toast.message}
          detail={toast.detail}
          type={toast.type}
          onDismiss={() => setToast(null)}
        />
      )}
    </div>
  );
}
