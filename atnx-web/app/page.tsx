"use client";

import { useEffect, useState } from "react";

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
}

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

function CaptureCard({ capture }: { capture: Capture }) {
  const [showRaw, setShowRaw] = useState(false);
  const [showMetrics, setShowMetrics] = useState(false);
  const { analysis } = capture;

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
        {analysis.error ? (
          <div className="text-red-400 text-sm">
            Error: {analysis.error}
          </div>
        ) : (
          <>
            <div className="flex items-center gap-3 flex-wrap">
              {analysis.type && (
                <span className="text-xs uppercase tracking-wider bg-atnx-bg px-2 py-0.5 rounded text-atnx-green border border-atnx-green/30">
                  {analysis.type}
                </span>
              )}
              {analysis.name && (
                <span className="font-bold text-atnx-green text-sm">
                  {analysis.name}
                </span>
              )}
            </div>

            <div className="flex gap-4 text-xs text-atnx-text-muted flex-wrap">
              {analysis.category && <span>CATEGORY: {analysis.category}</span>}
              {analysis.sentiment && (
                <span className={sentimentColor(analysis.sentiment)}>
                  SENTIMENT: {analysis.sentiment}
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
                {showMetrics ? "▾" : "▸"} Detected metrics
              </button>
            )}
          {analysis.raw_text && (
            <button
              onClick={() => setShowRaw(!showRaw)}
              className="text-atnx-green hover:text-atnx-green-dark cursor-pointer"
            >
              {showRaw ? "▾" : "▸"} Raw text
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

export default function Home() {
  const [captures, setCaptures] = useState<Capture[]>([]);

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

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 w-full">
      {/* Header */}
      <header className="flex items-center justify-between mb-8">
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
          {captures.map((capture) => (
            <CaptureCard key={capture.id} capture={capture} />
          ))}
        </div>
      )}
    </div>
  );
}
