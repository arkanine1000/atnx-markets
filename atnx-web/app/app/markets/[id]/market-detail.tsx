"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { DemoToast } from "@/components/Toast";
import { TradeDock } from "@/components/TradeDock";
import { BoundedTicket } from "@/components/bm/BoundedTicket";
import { ChainTradeLog } from "@/components/bm/ChainTradeLog";
import { PriceChip } from "@/components/bm/PriceChip";
import { useMyTrades } from "@/components/bm/useMyTrades";
import { RoundTicket } from "@/components/rounds/RoundTicket";
import { RoundChip } from "@/components/rounds/RoundChip";
import { RoundHistory } from "@/components/rounds/RoundHistory";
import { fmtUsdg } from "@/components/bm/format";
import { ShareButton } from "@/components/ShareButton";
import {
  ViChart,
  RANGES,
  isPreset,
  sliceRange,
  type ChartRange,
  type Range,
} from "@/components/charts/ViArea";
import { DateRangePicker } from "@/components/DateRangePicker";
import {
  Card,
  Chip,
  DeltaChip,
  Segmented,
  hostOf,
} from "@/components/ui";
import { sentimentColor, timeAgo, viChange24h } from "@/lib/capture-view";
import type { Capture, MarketNeighbor, MarketRow } from "@/lib/store";
import type { BmMarketRow, BmRoundRow, BmSeriesRow } from "@/lib/supabase/database-bm";
import { isRoundsDeployed } from "@/lib/bm/chains";
import type { TrendsResult } from "@/lib/trends";
import { viTier } from "@/lib/vi/score";
import { startPolling } from "@/lib/poll";

interface Props {
  market: MarketRow;
  // The markets either side of this one in virality order: a swipe on a
  // phone goes there (left for the next, right for the one before).
  neighbors?: { prev: MarketNeighbor | null; next: MarketNeighbor | null };
  // The subject this market is about, and the markets that are about this
  // one (supabase/010). Display only; either may be empty.
  parent?: MarketRow | null;
  childMarkets?: MarketRow[];
  captures: Capture[];
  trends: TrendsResult | null;
  // The bounded UP/DOWN markets on this market, every chain, newest first.
  bounded: BmMarketRow[];
  // The running rounds series on this market (Solana devnet) and its
  // rounds, newest first; null when none has been started.
  rounds?: { series: BmSeriesRow; rounds: BmRoundRow[] } | null;
}

type Tab = "pulse" | "activity" | "overview";

// The swipe between markets. A touch has to move this far sideways, and
// more sideways than up, before the page starts following the finger; on
// release past SWIPE_GO_PX it flies off and the neighbour loads, short of
// it the page springs back. Touches on the chart (which scrubs), inside
// the trade dock and its sheet, and on form fields are left alone.
const SWIPE_ARM_PX = 14;
const SWIPE_GO_PX = 90;
const SWIPE_IGNORE =
  "[data-no-swipe], .recharts-wrapper, input, textarea, select";

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
      type="up"
      onDismiss={() => setMessage(null)}
    />
  );
}

// One row of the "About" / "Tracked as" card: the market's image when it
// has a curated one, its name, type and current VI, linking to its page.
function RelatedMarketLink({ market }: { market: MarketRow }) {
  return (
    <Link
      href={`/app/markets/${market.id}`}
      className="flex items-center gap-3 p-2.5 rounded-xl border border-surface hover:border-atnx-cyan/30 transition-colors"
    >
      {market.thumbnail_url ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={market.thumbnail_url}
          alt=""
          loading="lazy"
          className="w-10 h-10 rounded-lg object-cover border border-surface bg-black shrink-0"
        />
      ) : (
        <div className="w-10 h-10 rounded-lg border border-surface bg-elevated shrink-0" />
      )}
      <div className="min-w-0 flex-1">
        <div className="text-xs font-bold text-primary truncate">
          {market.entity_name}
        </div>
        {market.entity_type && (
          <div className="text-[11px] text-tertiary mt-0.5">
            {market.entity_type}
          </div>
        )}
      </div>
      <div className="text-right shrink-0">
        <div className="text-[10px] font-mono uppercase tracking-wider text-tertiary">
          VI
        </div>
        <div className="font-bold text-atnx-yellow light:text-atnx-yellow-light tabular-nums">
          {market.vi_state === "scoring" ? "…" : Math.round(market.current_vi)}
        </div>
      </div>
    </Link>
  );
}

// The market's description, clamped to two lines with a "Show more" after
// the ellipsis. The toggle appears only when the text overflows the clamp,
// measured on mount and whenever the column's width changes.
function Description({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const ref = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Measured with the clamp on, so an open paragraph does not read as
    // fitting and lose its "Show less".
    const measure = () => {
      const clamped = el.classList.contains("line-clamp-2");
      if (!clamped) el.classList.add("line-clamp-2");
      setOverflows(el.scrollHeight > el.clientHeight + 1);
      if (!clamped) el.classList.remove("line-clamp-2");
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text]);

  return (
    <div className="mt-2">
      <p
        ref={ref}
        className={`text-xs sm:text-sm text-secondary leading-relaxed font-sans ${
          open ? "" : "line-clamp-2"
        }`}
      >
        {text}
      </p>
      {overflows && (
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          className="mt-0.5 text-xs text-secondary hover:text-atnx-cyan cursor-pointer"
        >
          {open ? "Show less" : "Show more"}
        </button>
      )}
    </div>
  );
}

export function MarketDetailClient({
  market,
  parent = null,
  childMarkets = [],
  captures,
  trends,
  bounded,
  rounds = null,
  neighbors,
}: Props) {
  const router = useRouter();
  const myTrades = useMyTrades(bounded);
  const tradeMarks = useMemo(
    () =>
      myTrades.map((m) => ({
        time: m.time,
        side: m.side,
        kind: m.kind,
        label: `${m.kind === "buy" ? "Bought" : "Sold"} ${fmtUsdg(m.shares)} ${m.side.toUpperCase()} ${m.kind === "buy" ? "for" : "for"} ${fmtUsdg(m.usdg)} USDG · ${new Date(m.time).toLocaleString(undefined, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}`,
      })),
    [myTrades],
  );
  const [selectedIdx, setSelectedIdx] = useState(0);
  const [range, setRange] = useState<ChartRange>("ALL");
  // The tab to return to when a calendar window is cleared.
  const lastPreset = useRef<Range>("ALL");
  const pickRange = useCallback((r: ChartRange | null) => {
    if (r === null) {
      setRange(lastPreset.current);
      return;
    }
    if (isPreset(r)) lastPreset.current = r;
    setRange(r);
  }, []);
  const [tab, setTab] = useState<Tab>("pulse");
  const [showRaw, setShowRaw] = useState(false);
  const [toast, setToast] = useState<{
    message: string;
    detail?: string;
    type: "up" | "down";
  } | null>(null);

  // captures is DESC by created_at: index 0 is the most recent.
  const selected = captures[selectedIdx] ?? captures[0];
  const latest = captures[0];
  const { analysis, viralityScore } = selected;
  const scoring = market.vi_state === "scoring";
  // A new market's first pass takes a minute or two; re-read the page until
  // it is live so the number and the trade ticket appear on their own.
  useEffect(() => {
    if (!scoring) return;
    return startPolling(async () => router.refresh(), { intervalMs: 10_000, maxIntervalMs: 30_000 });
  }, [scoring, router]);
  // The market's own name. Captures carry the name they were analysed
  // under, which for older ones can differ from the market they sit on.
  const name = market.entity_name || latest.analysis.name || "Untitled";
  const points = useMemo(() => trends?.dataPoints ?? [], [trends]);
  const change24h = useMemo(
    () => viChange24h(points, viralityScore),
    [points, viralityScore],
  );
  // The live bounded market (any chain) for the chart's bound lines; the
  // ticket picks the wallet's chain itself.
  const liveBounded = useMemo(
    () => bounded.find((b) => b.state === "open" || b.state === "pending" || b.state === "resolving") ?? null,
    [bounded],
  );

  // Rounds replace the bounded markets. A market with a series trades its
  // rounds; one without trades rounds too (the ticket offers to start a
  // series) once the program is deployed, unless a bounded market is
  // still live on it, which keeps its own ticket until it resolves.
  const series = rounds?.series ?? null;
  const roundRows = useMemo(() => rounds?.rounds ?? [], [rounds]);
  const showRounds = !!series || (isRoundsDeployed() && !liveBounded);
  // The live round's target for the chart.
  const roundTarget = useMemo(() => {
    const live = roundRows.find((r) => r.state === "opening" || r.state === "live" || r.state === "settling");
    return live && live.target_vi !== null
      ? { value: live.target_vi, label: `ROUND ${live.idx} TARGET ${Math.round(live.target_vi)}` }
      : null;
  }, [roundRows]);

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
  // The calendar offers the days the series covers (lib/store loads the
  // last 90 days), from the first point to today.
  const firstPointMs = useMemo(() => {
    const t = points.length ? new Date(points[0].date).getTime() : NaN;
    return Number.isFinite(t) ? t : undefined;
  }, [points]);

  const handleToast = useCallback(
    (message: string, detail: string | undefined, type: "up" | "down") => {
      setToast({ message, detail, type });
    },
    [],
  );

  // --- Swipe between markets. The page content follows the finger with
  // a little tilt from the bottom, Tinder-style, and the styles are set
  // straight on the element so a drag does not re-render the chart.
  const prev = neighbors?.prev ?? null;
  const next = neighbors?.next ?? null;
  const swipeRef = useRef<HTMLDivElement>(null);
  const gesture = useRef<{
    x: number;
    y: number;
    mode: "undecided" | "h" | "v";
  } | null>(null);
  const leaving = useRef(false);

  useEffect(() => {
    if (prev) router.prefetch(`/app/markets/${prev.id}`);
    if (next) router.prefetch(`/app/markets/${next.id}`);
  }, [router, prev, next]);

  const onTouchStart = (e: React.TouchEvent) => {
    if (leaving.current || (!prev && !next)) return;
    if ((e.target as Element).closest(SWIPE_IGNORE)) return;
    const t = e.touches[0];
    gesture.current = { x: t.clientX, y: t.clientY, mode: "undecided" };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const g = gesture.current;
    const el = swipeRef.current;
    if (!g || !el) return;
    const t = e.touches[0];
    const dx = t.clientX - g.x;
    const dy = t.clientY - g.y;
    if (g.mode === "undecided") {
      if (Math.abs(dy) > SWIPE_ARM_PX && Math.abs(dy) > Math.abs(dx)) {
        g.mode = "v";
      } else if (
        Math.abs(dx) > SWIPE_ARM_PX &&
        Math.abs(dx) > Math.abs(dy) * 1.5
      ) {
        g.mode = "h";
        el.style.transition = "none";
        el.style.transformOrigin = "50% 120%";
      }
    }
    if (g.mode !== "h") return;
    // Pulling toward a side with no neighbour gives way like a rubber band.
    const room = dx < 0 ? !!next : !!prev;
    const pull = room ? dx * 0.55 : dx * 0.15;
    el.style.transform = `translateX(${pull.toFixed(1)}px) rotate(${(pull * 0.02).toFixed(2)}deg)`;
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const g = gesture.current;
    const el = swipeRef.current;
    gesture.current = null;
    if (!g || !el || g.mode !== "h") return;
    const dx = e.changedTouches[0].clientX - g.x;
    const target = dx < 0 ? next : prev;
    if (Math.abs(dx) >= SWIPE_GO_PX && target) {
      leaving.current = true;
      const sign = dx < 0 ? -1 : 1;
      el.style.transition = "transform 220ms ease-in, opacity 220ms ease-in";
      el.style.transform = `translateX(${sign * 110}%) rotate(${sign * 6}deg)`;
      el.style.opacity = "0.5";
      window.setTimeout(() => router.push(`/app/markets/${target.id}`), 200);
      return;
    }
    el.style.transition = "transform 220ms cubic-bezier(0.22, 1, 0.36, 1)";
    el.style.transform = "";
  };

  return (
    // Bottom room on phones for the dock stacked above the tab bar, and
    // for the dock alone on tablets.
    <div className="pb-10 sm:pb-8 lg:pb-0">
      <Suspense fallback={null}>
        <SharedNotice name={name} />
      </Suspense>

      <div
        ref={swipeRef}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onTouchCancel={onTouchEnd}
        className="[touch-action:pan-y]"
      >
        {/* The market before and after this one by virality: where a swipe
            leads on a phone, and a link anywhere. Markets itself is a tap
            away in the nav, so there is no back link. */}
        {(prev || next) && (
          <div className="flex items-center justify-between gap-4 mb-3 text-[11px] text-tertiary">
            {prev ? (
              <Link
                href={`/app/markets/${prev.id}`}
                className="min-w-0 inline-flex items-center gap-1 link-quiet transition-colors"
              >
                <span aria-hidden="true">{"‹"}</span>
                <span className="truncate">{prev.name}</span>
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link
                href={`/app/markets/${next.id}`}
                className="min-w-0 inline-flex items-center gap-1 text-right link-quiet transition-colors"
              >
                <span className="truncate">{next.name}</span>
                <span aria-hidden="true">{"›"}</span>
              </Link>
            ) : (
              <span />
            )}
          </div>
        )}

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
                    <h1 className="font-display text-xl sm:text-2xl font-bold text-primary leading-tight break-words">
                      {name}
                    </h1>
                    <div className="flex items-center gap-1.5 flex-wrap mt-1.5">
                      {analysis.type && (
                        <Chip tone="cyan">{analysis.type}</Chip>
                      )}
                      {analysis.category && <Chip>{analysis.category}</Chip>}
                    </div>
                    {series ? (
                      <RoundChip series={series} rounds={roundRows} vi={viralityScore} />
                    ) : (
                      <PriceChip bounded={bounded} vi={viralityScore} />
                    )}
                    {market.description && (
                      <Description text={market.description} />
                    )}
                  </div>
                </div>

                <div className="sm:text-right shrink-0">
                  <div className="text-[10px] font-mono uppercase tracking-[0.15em] text-tertiary mb-1">
                    Virality Index
                  </div>
                  {scoring ? (
                    <div className="flex sm:justify-end items-baseline">
                      <span className="text-sm font-mono uppercase tracking-[0.12em] text-secondary animate-pulse">
                        Scoring…
                      </span>
                    </div>
                  ) : (
                    <div className="flex sm:justify-end items-baseline gap-2">
                      <span className="text-4xl font-bold text-atnx-yellow light:text-atnx-yellow-light leading-none">
                        {viralityScore}
                      </span>
                      <span className="text-[11px] font-mono uppercase tracking-[0.12em] text-secondary">
                        {viralityScore > 0 ? viTier(viralityScore).label : "No attention yet"}
                      </span>
                    </div>
                  )}
                  <div className="flex sm:justify-end items-center mt-2">
                    <DeltaChip value={change24h} size="md" />
                  </div>
                </div>
              </div>

              {/* Chart */}
              <div className="px-2 sm:px-3 pb-3">
                <div className="flex items-center justify-between gap-2 px-2 mb-1">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {/* The tabs scroll on the narrowest phones; the calendar
                        stays put beside them so its popover is never clipped. */}
                    <div className="min-w-0 overflow-x-auto scrollbar-none">
                      <Segmented
                        ariaLabel="Chart range"
                        value={isPreset(range) ? range : null}
                        onChange={pickRange}
                        options={rangeOptions}
                      />
                    </div>
                    <DateRangePicker
                      value={isPreset(range) ? null : range}
                      onChange={pickRange}
                      min={firstPointMs}
                      disabled={points.length < 2}
                      className="shrink-0"
                    />
                  </div>
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
                  bounds={
                    liveBounded && !series
                      ? { lower: liveBounded.lower_bound, upper: liveBounded.upper_bound }
                      : null
                  }
                  target={roundTarget}
                  marks={tradeMarks}
                  scoring={scoring}
                />
                {myTrades.length > 0 && (
                  <div className="px-2 mt-1 flex items-center gap-3 text-[10px] text-tertiary">
                    <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-atnx-cyan" /> UP buy</span>
                    <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full bg-atnx-magenta" /> DOWN buy</span>
                    <span className="inline-flex items-center gap-1"><span className="inline-block h-2 w-2 rounded-full border-2 border-atnx-cyan" /> sell</span>
                  </div>
                )}
              </div>
            </Card>

            {/* What this market is about, and what is about it. Display only. */}
            {(parent || childMarkets.length > 0) && (
              <Card className="p-4 sm:p-5 space-y-3">
                {parent && (
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-wider text-tertiary mb-1.5">
                      About
                    </div>
                    <RelatedMarketLink market={parent} />
                  </div>
                )}
                {childMarkets.length > 0 && (
                  <div>
                    <div className="text-[10px] font-mono uppercase tracking-wider text-tertiary mb-1.5">
                      Tracked as
                    </div>
                    <ul className="space-y-2">
                      {childMarkets.map((m) => (
                        <li key={m.id}>
                          <RelatedMarketLink market={m} />
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </Card>
            )}

            {/* Tabs */}
            <Card>
              <div
                role="tablist"
                className="flex items-center border-b border-surface px-1 sm:px-2"
              >
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
                      className={`px-3 sm:px-4 py-3 text-xs font-bold whitespace-nowrap -mb-px border-b-2 transition-colors cursor-pointer ${
                        active
                          ? "border-atnx-cyan text-primary"
                          : "border-transparent text-secondary link-quiet"
                      }`}
                    >
                      {label}
                    </button>
                  );
                })}
                {/* Share sits with the tabs, so nothing sits above the
                    chart but the market itself. */}
                <ShareButton
                  title={`${name} on ATNX`}
                  text={`${name} · Virality Index ${viralityScore}`}
                  path={`/app/markets/${market.id}`}
                  className="ml-auto mr-1 h-7 shrink-0"
                  compact
                />
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

                {tab === "activity" &&
                  (series ? (
                    <div className="space-y-5">
                      <RoundHistory series={series} rounds={roundRows} />
                      {liveBounded && <ChainTradeLog bounded={bounded} />}
                    </div>
                  ) : (
                    <ChainTradeLog bounded={bounded} />
                  ))}

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
                            <span className="text-tertiary font-mono uppercase tracking-wider text-[10px] mr-2">
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
                            [
                              "Bounds",
                              liveBounded
                                ? `${liveBounded.lower_bound} – ${liveBounded.upper_bound}`
                                : undefined,
                            ],
                            [
                              "Opened at VI",
                              liveBounded ? Math.round(liveBounded.start_vi) : undefined,
                            ],
                          ]
                            .filter(([, v]) => v !== undefined && v !== "")
                            .map(([k, v]) => (
                              <div
                                key={String(k)}
                                className="rounded-xl border border-surface bg-elevated p-3 min-w-0"
                              >
                                <dt className="text-[10px] font-mono uppercase tracking-wider text-tertiary">
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
                              <div className="text-[10px] font-mono uppercase tracking-wider text-tertiary mb-1.5">
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
                              <div className="text-[10px] font-mono uppercase tracking-wider text-tertiary mb-1.5">
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
            {showRounds ? (
              <RoundTicket
                atnxMarketId={market.id}
                name={name}
                score={viralityScore}
                scoring={scoring}
                viUpdatedAt={market.vi_last_updated}
                series={series}
                rounds={roundRows}
                onToast={handleToast}
              />
            ) : (
              <BoundedTicket
                atnxMarketId={market.id}
                name={name}
                score={viralityScore}
                scoring={scoring}
                bounded={bounded}
                onToast={handleToast}
              />
            )}
          </aside>
        </div>
      </div>

      {/* Phones: UP / DOWN anchored at the bottom, the ticket in a sheet
          behind them. Outside the swiped element so the fixed dock does
          not move with the page. */}
      <TradeDock
        renderTicket={(side) =>
          showRounds ? (
            <RoundTicket
              key={side}
              atnxMarketId={market.id}
              name={name}
              score={viralityScore}
              scoring={scoring}
              viUpdatedAt={market.vi_last_updated}
              series={series}
              rounds={roundRows}
              onToast={handleToast}
              initialSide={side}
            />
          ) : (
            <BoundedTicket
              key={side}
              atnxMarketId={market.id}
              name={name}
              score={viralityScore}
              scoring={scoring}
              bounded={bounded}
              onToast={handleToast}
              initialSide={side}
            />
          )
        }
      />

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
