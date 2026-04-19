"use client";

import Link from "next/link";
import { useMemo, useState, useCallback } from "react";
import { Nav } from "@/components/Nav";
import {
  TrendSparkline,
  getTrendIndicator,
  TradeModal,
  DemoToast,
} from "@/components/Trading";
import { useDemoContext } from "@/context/DemoContext";
import { mock24hChange, sentimentColor, timeAgo } from "@/lib/capture-view";
import type { Capture, MarketRow } from "@/lib/store";
import type { TrendsResult } from "@/lib/trends";

interface Props {
  market: MarketRow;
  latest: Capture;
  captures: Capture[];
  trends: TrendsResult | null;
  captureCount: number;
}

export function MarketDetailClient({
  market,
  latest,
  trends,
  captureCount,
}: Props) {
  const { positions } = useDemoContext();
  const [showMetrics, setShowMetrics] = useState(false);
  const [showRaw, setShowRaw] = useState(false);
  const [tradingCapture, setTradingCapture] = useState<Capture | null>(null);
  const [toast, setToast] = useState<{
    message: string;
    detail: string;
    type: "long" | "short";
  } | null>(null);

  const { analysis, viralityScore } = latest;
  const trendInfo = getTrendIndicator(trends?.trend);
  const change24h = useMemo(
    () => mock24hChange(market.id, viralityScore),
    [market.id, viralityScore]
  );
  const changeArrow = change24h >= 0 ? "\u25B2" : "\u25BC";
  const changeArrowColor = change24h >= 0 ? "#00D4FF" : "#FF00E5";

  const openPos = positions.find((p) => p.marketId === market.id);

  const handleTradeClose = useCallback(
    (outcome: "opened" | "cancelled") => {
      if (outcome === "opened" && tradingCapture) {
        setToast({
          message: "Position Opened",
          detail: `${tradingCapture.analysis.name} @ ${tradingCapture.viralityScore}`,
          type: "long",
        });
      }
      setTradingCapture(null);
    },
    [tradingCapture]
  );

  const sourceHost = (() => {
    try {
      return new URL(latest.pageUrl).hostname;
    } catch {
      return latest.pageUrl || "\u2014";
    }
  })();

  return (
    <div className="max-w-4xl mx-auto px-4 py-8 w-full">
      <Nav captureCount={captureCount} />

      <Link
        href="/app"
        className="inline-flex items-center gap-1 text-xs text-secondary hover:text-atnx-cyan transition-colors mb-4"
      >
        <span>{"\u2190"}</span> Back to dashboard
      </Link>

      <div className="bg-surface border border-surface rounded-lg overflow-hidden">
        <div className="px-3 sm:px-5 py-5 space-y-4">
          <div className="flex flex-col sm:flex-row gap-4">
            <div className="shrink-0">
              <img
                src={latest.screenshot}
                alt="Capture"
                className="w-full sm:w-56 h-52 sm:h-40 object-cover rounded border border-surface"
              />
            </div>

            <div className="flex-1 min-w-0 space-y-3">
              <div className="flex items-start justify-between gap-3 flex-wrap">
                <div className="flex items-center gap-2 flex-wrap">
                  {analysis.type && (
                    <span className="text-xs uppercase tracking-wider bg-atnx-cyan/10 px-2 py-0.5 rounded text-atnx-cyan border border-atnx-cyan/30">
                      {analysis.type}
                    </span>
                  )}
                  <h1 className="font-bold text-atnx-cyan text-lg sm:text-xl break-words">
                    {analysis.name || market.entity_name}
                  </h1>
                </div>
                <div className="flex items-center gap-3 shrink-0">
                  <span className="text-xl font-bold font-mono tabular-nums text-atnx-yellow bg-atnx-yellow/10 border border-atnx-yellow/25 px-2 py-0.5 rounded">
                    {viralityScore}
                  </span>
                  <span
                    className="text-xs font-bold"
                    style={{ color: trendInfo.color }}
                  >
                    {trendInfo.icon} {trendInfo.label}
                  </span>
                  <span className="text-xs font-mono font-bold flex items-center gap-1">
                    <span style={{ color: changeArrowColor }}>
                      {changeArrow}
                    </span>
                    <span className="text-atnx-yellow">
                      {Math.abs(change24h)}%
                    </span>
                  </span>
                </div>
              </div>

              <div className="max-w-lg">
                <TrendSparkline
                  dataPoints={trends?.dataPoints ?? []}
                  color="#00D4FF"
                  height={80}
                  entryIndex={openPos?.entryIndex}
                  positionType={openPos?.type}
                />
              </div>

              {analysis.error ? (
                <div className="text-atnx-magenta text-sm">
                  Error: {analysis.error}
                </div>
              ) : (
                <>
                  <div className="flex gap-4 text-xs text-secondary flex-wrap">
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
                        PEAK:{" "}
                        <span className="text-atnx-cyan">
                          {trends.peakValue}
                        </span>{" "}
                        | NOW:{" "}
                        <span className="text-atnx-cyan">
                          {trends.currentValue}
                        </span>
                      </span>
                    )}
                  </div>

                  {analysis.description && (
                    <p className="text-sm text-primary leading-relaxed font-sans italic">
                      &ldquo;{analysis.description}&rdquo;
                    </p>
                  )}

                  {analysis.virality_signals && (
                    <p className="text-xs text-secondary">
                      Virality: {analysis.virality_signals}
                    </p>
                  )}

                  {analysis.platforms_detected &&
                    analysis.platforms_detected.length > 0 && (
                      <div className="flex gap-1.5 flex-wrap">
                        {analysis.platforms_detected.map((p) => (
                          <span
                            key={p}
                            className="text-xs bg-atnx-cyan/10 px-1.5 py-0.5 rounded text-atnx-cyan"
                          >
                            {p}
                          </span>
                        ))}
                      </div>
                    )}
                </>
              )}

              <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 pt-1">
                <div className="flex gap-3 sm:gap-4 text-xs text-tertiary flex-wrap min-w-0">
                  <span className="truncate">SOURCE: {sourceHost}</span>
                  <span className="whitespace-nowrap">
                    CAPTURED: {timeAgo(latest.timestamp)}
                  </span>
                </div>

                <button
                  onClick={() => setTradingCapture(latest)}
                  className="text-xs px-4 py-2 rounded border border-atnx-magenta text-atnx-magenta hover:bg-atnx-magenta hover:text-black cursor-pointer transition-colors font-bold w-full sm:w-auto shrink-0"
                >
                  Trade This
                </button>
              </div>

              <div className="flex gap-3 text-xs pt-1">
                {analysis.metrics_detected &&
                  Object.keys(analysis.metrics_detected).length > 0 && (
                    <button
                      onClick={() => setShowMetrics((v) => !v)}
                      className="text-atnx-cyan hover:text-atnx-cyan-dim cursor-pointer"
                    >
                      {showMetrics ? "\u25BE" : "\u25B8"} Detected metrics
                    </button>
                  )}
                {analysis.raw_text && (
                  <button
                    onClick={() => setShowRaw((v) => !v)}
                    className="text-atnx-cyan hover:text-atnx-cyan-dim cursor-pointer"
                  >
                    {showRaw ? "\u25BE" : "\u25B8"} Raw text
                  </button>
                )}
              </div>

              {showMetrics && analysis.metrics_detected && (
                <div className="bg-dark-primary rounded p-2 text-xs space-y-0.5">
                  {Object.entries(analysis.metrics_detected).map(([k, v]) => (
                    <div key={k}>
                      <span className="text-secondary">{k}:</span>{" "}
                      <span className="text-primary">{String(v)}</span>
                    </div>
                  ))}
                </div>
              )}

              {showRaw && analysis.raw_text && (
                <div className="bg-dark-primary rounded p-2 text-xs text-secondary whitespace-pre-wrap break-words max-h-48 overflow-auto">
                  {analysis.raw_text}
                </div>
              )}
            </div>
          </div>
        </div>
      </div>

      {tradingCapture && (
        <TradeModal capture={tradingCapture} onClose={handleTradeClose} />
      )}

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
