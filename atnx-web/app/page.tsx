"use client";

import { useEffect, useState } from "react";
import {
  LineChart,
  Line,
  ResponsiveContainer,
  YAxis,
} from "recharts";

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

function getScoreColor(score: number): string {
  if (score >= 800) return "#FF0040";
  if (score >= 600) return "#FF6600";
  if (score >= 400) return "#FFD700";
  if (score >= 200) return "#00FF66";
  return "#888888";
}

function getTrendIndicator(trend?: string): { icon: string; label: string } {
  switch (trend) {
    case "spiking":
      return { icon: "\u25B2", label: "SPIKING" };
    case "rising":
      return { icon: "\u2197", label: "RISING" };
    case "stable":
      return { icon: "\u2192", label: "STABLE" };
    case "falling":
      return { icon: "\u2198", label: "FALLING" };
    default:
      return { icon: "\u2605", label: "NEW" };
  }
}

function TrendSparkline({
  dataPoints,
  color = "#00FF66",
}: {
  dataPoints: { date: string; value: number }[];
  color?: string;
}) {
  if (!dataPoints || dataPoints.length === 0) {
    return (
      <div className="h-[50px] flex items-center justify-center text-atnx-text-muted text-xs">
        No trend data
      </div>
    );
  }

  return (
    <div className="h-[50px] w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={dataPoints}>
          <YAxis domain={[0, 100]} hide />
          <Line
            type="monotone"
            dataKey="value"
            stroke={color}
            strokeWidth={1.5}
            dot={false}
            isAnimationActive={false}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function CaptureCard({ capture }: { capture: Capture }) {
  const [showRaw, setShowRaw] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const { analysis, trends, viralityScore } = capture;
  const scoreColor = getScoreColor(viralityScore);
  const trendInfo = getTrendIndicator(trends?.trend);

  return (
    <div className="bg-atnx-surface border border-atnx-border rounded-lg p-4 flex gap-4">
      {/* Thumbnail */}
      <div className="shrink-0">
        <img
          src={`data:image/png;base64,${capture.screenshot}`}
          alt="Capture"
          className="w-32 h-24 object-cover rounded border border-atnx-border"
        />
      </div>

      {/* Details */}
      <div className="flex-1 min-w-0 space-y-1.5">
        {/* Score + Trend row */}
        <div className="flex items-start justify-between gap-3">
          <div className="flex items-center gap-3 flex-wrap min-w-0">
            {analysis.type && (
              <span className="text-xs uppercase tracking-wider bg-atnx-bg px-2 py-0.5 rounded text-atnx-green border border-atnx-green/30">
                {analysis.type}
              </span>
            )}
            {analysis.name && (
              <span className="font-bold text-atnx-green text-sm truncate">
                {analysis.name}
              </span>
            )}
          </div>

          {/* Virality score badge */}
          <div className="shrink-0 flex items-center gap-2">
            <span
              className="text-xs font-bold tracking-wide"
              style={{ color: scoreColor }}
            >
              {trendInfo.icon} {trendInfo.label}
            </span>
            <span
              className="text-xl font-bold tabular-nums px-2 py-0.5 rounded"
              style={{
                color: scoreColor,
                backgroundColor: `${scoreColor}15`,
                borderWidth: 1,
                borderColor: `${scoreColor}40`,
              }}
            >
              {viralityScore}
            </span>
          </div>
        </div>

        {/* Sparkline */}
        <div className="max-w-xs">
          <TrendSparkline
            dataPoints={trends?.dataPoints ?? []}
            color={scoreColor}
          />
        </div>

        {analysis.error ? (
          <div className="text-red-400 text-sm">Error: {analysis.error}</div>
        ) : (
          <>
            <div className="flex gap-4 text-xs text-atnx-text-muted flex-wrap">
              {analysis.category && <span>CATEGORY: {analysis.category}</span>}
              {analysis.sentiment && (
                <span className={sentimentColor(analysis.sentiment)}>
                  SENTIMENT: {analysis.sentiment}
                </span>
              )}
              {trends && (
                <span className="text-atnx-text-muted">
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

        <div className="flex gap-4 text-xs text-atnx-text-muted pt-1">
          <span>SOURCE: {new URL(capture.pageUrl).hostname}</span>
          <span>CAPTURED: {timeAgo(capture.timestamp)}</span>
        </div>

        {/* Collapsible sections */}
        <div className="flex gap-3 text-xs pt-1">
          {analysis.metrics_detected &&
            Object.keys(analysis.metrics_detected).length > 0 && (
              <button
                onClick={() => setShowMetrics(!showMetrics)}
                className="text-atnx-green hover:text-atnx-green-dark cursor-pointer"
              >
                {showMetrics ? "\u25BE" : "\u25B8"} Detected metrics
              </button>
            )}
          {analysis.raw_text && (
            <button
              onClick={() => setShowRaw(!showRaw)}
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

  const sorted = sortCaptures(captures, sortMode);

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 w-full">
      {/* Header */}
      <header className="flex items-center justify-between mb-6">
        <div>
          <h1 className="text-2xl font-bold text-atnx-green tracking-widest">
            ATNX
          </h1>
          <p className="text-xs text-atnx-text-muted tracking-wide">
            Attention Exchange
          </p>
        </div>
        <div className="text-sm text-atnx-text-muted bg-atnx-surface px-3 py-1.5 rounded border border-atnx-border">
          {captures.length} Capture{captures.length !== 1 ? "s" : ""}
        </div>
      </header>

      {/* Sort controls */}
      {captures.length > 0 && (
        <div className="flex items-center gap-2 mb-6 text-xs">
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
        <div className="space-y-4">
          {sorted.map((capture) => (
            <CaptureCard key={capture.id} capture={capture} />
          ))}
        </div>
      )}
    </div>
  );
}
