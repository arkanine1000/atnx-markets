"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useState } from "react";
import { DemoToast, getTrendIndicator } from "@/components/Trading";
import { ShareButton } from "@/components/ShareButton";
import {
  ViChart,
  RANGES,
  sliceRange,
  type Range,
} from "@/components/charts/ViArea";
import { TradePanel } from "@/components/TradePanel";
import { TradeLog } from "@/components/TradeLog";
import { Card, Chip, DeltaChip, Segmented, hostOf } from "@/components/ui";
import { useDemoContext } from "@/context/DemoContext";
import { mock24hChange, sentimentColor, timeAgo } from "@/lib/capture-view";
import type { Capture, MarketRow, TradeLogEvent } from "@/lib/store";
import type { TrendsResult } from "@/lib/trends";
import { viTier } from "@/lib/vi/score";

interface Props {
  market: MarketRow;
  captures: Capture[];
  trends: TrendsResult | null;
  initialTradeLog: TradeLogEvent[];
}

type Tab = "pulse" | "activity" | "overview";

// After a share-sheet capture the route lands here with ?shared=<outcome>.
// One toast says what happened, then the flag comes off the URL so a
// reload or a back-navigation does not repeat it.
const SHARED_MESSAGE: Record<string, string> = {
  created: "New market created",
  created_review: "New market created, flagged for a second look",
  linked: "Linked to an existing market",
  matched: "Linked to an existing market",
  dedup: "Already captured before, same answer",
};

function SharedNotice({ name }: { name: string }) {
  const searchParams = useSearchParams();
  const outcome = searchParams.get("shared");
  const [message, setMessage] = useState<string | null>(() =>
    outcome ? (SHARED_MESSAGE[outcome] ?? "Captured") : null,
  );

  useEffect(() => {
    if (!outcome) return;
    const url = new URL(window.location.href);
    url.searchParams.delete("shared");
    window.history.replaceState(window.history.state, "", url.toString());
  }, [outcome]);

  if (!message) return null;
  return (
    <DemoToast
      message="Captured"
      detail={`${message} · ${name}`}
      type="long"
      onDismiss={() => setMessage(null)}
    />
  );
}

export function MarketDetailClient({
  market,
  captures,
  trends,
  initialTradeLog,
}: Props) {
  const { positions } = useDemoContext();
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [range, setRange] = useState<Range>("ALL");
  const [tab, setTab] = useState<Tab>("pulse");
  const [showRaw, setShowRaw] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    detail: string;
    type: "long" | "short";
  } | null>(null);

  // captures is DESC by created_at: index 0 is the most recent.
  const selected = captures[selectedIdx] ?? captures[0];
  const latest = captures[0];
  const { analysis, viralityScore } = selected;
  const name = latest.analysis.name || market.entity_name;
  const points = useMemo(() => trends?.dataPoints ?? [], [trends]);
  const trendInfo = getTrendIndicator(trends?.trend);
  const change24h = useMemo(
    () => mock24hChange(market.id, viralityScore),
    [market.id, viralityScore],
  );
  const openPos = positions.find((p) => p.marketId === market.id);

  // A range tab is only offered when it has something to draw.
  const rangeOptions = useMemo(
    () =>
      RANGES.map((r) => ({
        value: r,
        label: r === "ALL" ? "All" : r,
        disabled: sliceRange(points, r).length < 2,
      })),
    [points],
  );

  const handleOpened = useCallback(
    (side: "long" | "short", size: number) => {
      setToast({
        message: `${side === "long" ? "Long" : "Short"} opened`,
        detail: `${name} · $${size.toFixed(2)} @ VI ${viralityScore}`,
        type: side,
      });
    },
    [name, viralityScore],
  );

  return (
    <div>
      <Suspense fallback={null}>
        <SharedNotice name={name} />
      </Suspense>

      <div className="flex items-center justify-between gap-3 mb-4">
        <Link
          href="/app"
          className="inline-flex items-center gap-1.5 text-xs text-secondary hover:text-atnx-cyan transition-colors"
        >
          <span aria-hidden="true">{"←"}</span> Markets
        </Link>
        <ShareButton
          title={`${name} on ATNX`}
          text={`${name} · Virality Index ${viralityScore}`}
          path={`/app/markets/${market.id}`}
        />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1fr)_340px] gap-4 lg:gap-6 items-start">
        {/* ------------------------------------------------ main column */}
        <div className="space-y-4 min-w-0">
          <Card className="overflow-hidden">
            {/* Header */}
            <div className="p-4 sm:p-5 flex flex-col sm:flex-row sm:items-start gap-4">
              <div className="flex items-start gap-3 min-w-0 flex-1">
                {/* eslint-disable-next-line @next/next/no-img-element */}
                <img
                  src={selected.screenshot}
                  alt=""
                  className="w-14 h-14 sm:w-16 sm:h-16 rounded-xl object-cover border border-surface bg-black shrink-0"
                />
                <div className="min-w-0">
                  <h1 className="text-xl sm:text-2xl font-bold text-primary leading-tight break-words">
                    {name}
                  </h1>
                  <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                    {analysis.type && <Chip tone="cyan">{analysis.type}</Chip>}
                    {analysis.category && <Chip>{analysis.category}</Chip>}
                    <span className="text-[11px] text-tertiary">
                      {market.total_captures || captures.length} capture
                      {(market.total_captures || captures.length) === 1
                        ? ""
                        : "s"}
                    </span>
                  </div>
                </div>
              </div>

              <div className="sm:text-right shrink-0">
                <div className="text-[10px] uppercase tracking-[0.15em] text-tertiary mb-1">
                  Virality Index
                </div>
                <div className="flex sm:justify-end items-baseline gap-2">
                  <span className="text-4xl font-bold text-atnx-yellow light:text-atnx-yellow-light leading-none">
                    {viralityScore}
                  </span>
                  <span className="text-[11px] uppercase tracking-[0.12em] text-secondary">
                    {viTier(viralityScore).label}
                  </span>
                </div>
                <div className="flex sm:justify-end items-center gap-2 mt-2">
                  <DeltaChip value={change24h} size="md" />
                  <span
                    className={`text-[11px] font-bold ${trendInfo.className}`}
                  >
                    {trendInfo.icon} {trendInfo.label}
                  </span>
                </div>
              </div>
            </div>

            {/* Chart */}
            <div className="px-2 sm:px-3 pb-3">
              <div className="flex items-center justify-between px-2 mb-1">
                <Segmented
                  ariaLabel="Chart range"
                  value={range}
                  onChange={setRange}
                  options={rangeOptions}
                />
                {trends && (
                  <div className="hidden sm:flex items-center gap-3 text-[11px] text-tertiary font-mono">
                    <span>
                      peak{" "}
                      <span className="text-primary">
                        {Math.round(trends.peakValue)}
                      </span>
                    </span>
                    <span>
                      now{" "}
                      <span className="text-primary">
                        {Math.round(trends.currentValue)}
                      </span>
                    </span>
                  </div>
                )}
              </div>
              <ViChart
                dataPoints={points}
                range={range}
                height={280}
                entryVi={openPos?.entryIndex}
                entryType={openPos?.type}
              />
            </div>
          </Card>

          {/* Mobile: order ticket sits right under the chart */}
          <div className="lg:hidden">
            <TradePanel
              marketId={market.id}
              name={name}
              category={analysis.category || market.entity_type || "other"}
              captureId={selected.id}
              score={viralityScore}
              openPosition={openPos}
              onOpened={handleOpened}
            />
          </div>

          {/* Tabs */}
          <Card>
            <div role="tablist" className="flex border-b border-surface px-2">
              {(
                [
                  ["pulse", `Pulse (${captures.length})`],
                  ["activity", "Activity"],
                  ["overview", "Overview"],
                ] as [Tab, string][]
              ).map(([id, label]) => {
                const active = tab === id;
                return (
                  <button
                    key={id}
                    role="tab"
                    type="button"
                    aria-selected={active}
                    onClick={() => setTab(id)}
                    className={`px-4 py-3 text-xs font-bold -mb-px border-b-2 transition-colors cursor-pointer ${
                      active
                        ? "border-atnx-cyan text-primary"
                        : "border-transparent text-secondary hover:text-primary"
                    }`}
                  >
                    {label}
                  </button>
                );
              })}
            </div>

            <div className="p-4 sm:p-5">
              {tab === "pulse" && (
                <ul className="space-y-2">
                  {captures.map((c, i) => {
                    const active = i === selectedIdx;
                    return (
                      <li key={c.id}>
                        <button
                          type="button"
                          onClick={() => setSelectedIdx(i)}
                          className={`w-full text-left flex gap-3 p-2.5 rounded-xl border transition-colors cursor-pointer ${
                            active
                              ? "border-atnx-cyan/40 bg-atnx-cyan/5"
                              : "border-surface hover:border-atnx-cyan/30"
                          }`}
                        >
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={c.screenshot}
                            alt=""
                            loading="lazy"
                            className="w-24 h-16 rounded-lg object-cover border border-surface bg-black shrink-0"
                          />
                          <div className="min-w-0 flex-1">
                            <div className="flex items-center justify-between gap-2">
                              <span className="text-xs font-bold text-primary truncate">
                                {c.pageTitle ||
                                  c.analysis.name ||
                                  hostOf(c.pageUrl)}
                              </span>
                              <span className="text-[11px] text-tertiary shrink-0">
                                {timeAgo(c.timestamp)}
                              </span>
                            </div>
                            <div className="text-[11px] text-tertiary truncate mt-0.5">
                              {hostOf(c.pageUrl)}
                              {c.analysis.sentiment && (
                                <>
                                  {" · "}
                                  <span
                                    className={sentimentColor(
                                      c.analysis.sentiment,
                                    )}
                                  >
                                    {c.analysis.sentiment}
                                  </span>
                                </>
                              )}
                            </div>
                            {c.analysis.description && (
                              <p className="text-xs text-secondary mt-1 line-clamp-2 font-sans">
                                {c.analysis.description}
                              </p>
                            )}
                          </div>
                        </button>
                        {active && c.pageUrl && (
                          <a
                            href={c.pageUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="inline-flex items-center gap-1 mt-1 ml-1 text-[11px] text-secondary hover:text-atnx-cyan"
                          >
                            Open source {"↗"}
                          </a>
                        )}
                      </li>
                    );
                  })}
                </ul>
              )}

              {tab === "activity" && (
                <TradeLog
                  marketId={market.id}
                  initialEvents={initialTradeLog}
                />
              )}

              {tab === "overview" && (
                <div className="space-y-4">
                  {analysis.error ? (
                    <div className="text-atnx-magenta text-sm">
                      Error: {analysis.error}
                    </div>
                  ) : (
                    <>
                      {analysis.description && (
                        <p className="text-sm text-primary leading-relaxed font-sans">
                          {analysis.description}
                        </p>
                      )}
                      {analysis.virality_signals && (
                        <p className="text-xs text-secondary leading-relaxed font-sans">
                          <span className="text-tertiary uppercase tracking-wider text-[10px] mr-2">
                            Signals
                          </span>
                          {analysis.virality_signals}
                        </p>
                      )}

                      <dl className="grid grid-cols-2 sm:grid-cols-3 gap-3 text-xs">
                        {[
                          ["Category", analysis.category],
                          ["Type", analysis.type],
                          ["Sentiment", analysis.sentiment],
                          [
                            "Peak VI",
                            trends ? Math.round(trends.peakValue) : undefined,
                          ],
                          [
                            "Current VI",
                            trends
                              ? Math.round(trends.currentValue)
                              : undefined,
                          ],
                          ["Source", hostOf(selected.pageUrl)],
                        ]
                          .filter(([, v]) => v !== undefined && v !== "")
                          .map(([k, v]) => (
                            <div
                              key={String(k)}
                              className="rounded-xl border border-surface bg-elevated p-3 min-w-0"
                            >
                              <dt className="text-[10px] uppercase tracking-wider text-tertiary">
                                {k}
                              </dt>
                              <dd
                                className={`mt-1 font-bold truncate ${
                                  k === "Sentiment"
                                    ? sentimentColor(String(v))
                                    : "text-primary"
                                }`}
                              >
                                {String(v)}
                              </dd>
                            </div>
                          ))}
                      </dl>

                      {analysis.platforms_detected &&
                        analysis.platforms_detected.length > 0 && (
                          <div>
                            <div className="text-[10px] uppercase tracking-wider text-tertiary mb-1.5">
                              Platforms
                            </div>
                            <div className="flex gap-1.5 flex-wrap">
                              {analysis.platforms_detected.map((p) => (
                                <Chip key={p} tone="cyan">
                                  {p}
                                </Chip>
                              ))}
                            </div>
                          </div>
                        )}

                      {analysis.metrics_detected &&
                        Object.keys(analysis.metrics_detected).length > 0 && (
                          <div>
                            <div className="text-[10px] uppercase tracking-wider text-tertiary mb-1.5">
                              Detected metrics
                            </div>
                            <dl className="rounded-xl border border-surface bg-elevated text-xs">
                              {Object.entries(analysis.metrics_detected).map(
                                ([k, v]) => (
                                  <div
                                    key={k}
                                    className="flex justify-between gap-3 px-3 py-2 border-b border-surface last:border-b-0"
                                  >
                                    <dt className="text-secondary truncate">
                                      {k}
                                    </dt>
                                    <dd className="text-primary font-mono tabular-nums shrink-0">
                                      {String(v)}
                                    </dd>
                                  </div>
                                ),
                              )}
                            </dl>
                          </div>
                        )}

                      {analysis.raw_text && (
                        <div>
                          <button
                            type="button"
                            onClick={() => setShowRaw((v) => !v)}
                            className="text-xs text-secondary hover:text-atnx-cyan cursor-pointer"
                          >
                            {showRaw ? "▾" : "▸"} Raw captured text
                          </button>
                          {showRaw && (
                            <pre className="mt-2 rounded-xl border border-surface bg-elevated p-3 text-[11px] text-secondary whitespace-pre-wrap break-words max-h-56 overflow-auto font-sans">
                              {analysis.raw_text}
                            </pre>
                          )}
                        </div>
                      )}
                    </>
                  )}
                </div>
              )}
            </div>
          </Card>
        </div>

        {/* ------------------------------------------------ side column */}
        <aside className="hidden lg:block lg:sticky lg:top-24">
          <TradePanel
            marketId={market.id}
            name={name}
            category={analysis.category || market.entity_type || "other"}
            captureId={selected.id}
            score={viralityScore}
            openPosition={openPos}
            onOpened={handleOpened}
          />
        </aside>
      </div>

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
