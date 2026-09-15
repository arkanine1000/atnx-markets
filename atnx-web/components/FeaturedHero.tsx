"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ViSparkline, polarityColor } from "@/components/charts/ViArea";
import { Card, Chip, DeltaChip } from "@/components/ui";
import { HowItWorksModal } from "@/components/HowItWorksModal";
import { mock24hChange } from "@/lib/capture-view";
import type { Capture } from "@/lib/store";

const ROTATE_MS = 6000;
const FEATURED = 5;

// Polymarket-style top row: what the platform is on the left, and a large
// auto-rotating showcase of the most viral markets on the right.
export function FeaturedHero({ captures }: { captures: Capture[] }) {
  const featured = useMemo(
    () =>
      [...captures]
        .filter((c) => c.marketId)
        .sort((a, b) => b.viralityScore - a.viralityScore)
        .slice(0, FEATURED),
    [captures],
  );

  return (
    // Fixed height on desktop so the row doesn't jump as slides change.
    <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:h-[400px] gap-4 mb-8">
      <Intro />
      {featured.length > 0 && <Showcase items={featured} />}
    </section>
  );
}

const STEPS = [
  {
    n: "1",
    title: "Capture anything",
    cls: "bg-atnx-cyan/10 text-atnx-cyan light:text-atnx-cyan-light border-atnx-cyan/25",
  },
  {
    n: "2",
    title: "Long or Short",
    cls: "bg-atnx-magenta/10 text-atnx-magenta light:text-atnx-magenta-light border-atnx-magenta/25",
  },
  {
    n: "3",
    title: "Profit for being right.",
    cls: "bg-atnx-yellow/10 text-atnx-yellow light:text-atnx-yellow-light border-atnx-yellow/25",
  },
];

function Intro() {
  const [showHow, setShowHow] = useState(false);
  return (
    <Card className="relative overflow-hidden p-6 sm:p-8 flex flex-col justify-center min-h-[260px]">
      {/* brand wash */}
      <div
        aria-hidden="true"
        className="pointer-events-none absolute -top-24 -right-24 h-64 w-64 rounded-full opacity-25 blur-3xl"
        style={{
          background:
            "conic-gradient(from 180deg, #00D4FF, #FF00E5, #FFE500, #00D4FF)",
        }}
      />
      <div className="relative">
        <h2 className="text-3xl sm:text-4xl font-bold text-primary tracking-tight leading-tight">
          Trade attention,
          <br />
          not tokens.
        </h2>
        <ol className="mt-7 space-y-4">
          {STEPS.map((s) => (
            <li key={s.n} className="flex items-center gap-3.5">
              <span
                className={`h-8 w-8 shrink-0 rounded-lg inline-flex items-center justify-center text-sm font-bold font-mono border ${s.cls}`}
              >
                {s.n}
              </span>
              <span className="text-base sm:text-lg font-normal text-secondary">
                {s.title}
              </span>
            </li>
          ))}
        </ol>
        <button
          type="button"
          onClick={() => setShowHow(true)}
          className="mt-7 inline-flex items-center gap-1.5 rounded-full border border-surface bg-elevated px-4 py-2 text-xs font-bold text-primary hover:border-atnx-cyan/50 hover:text-atnx-cyan cursor-pointer transition-colors"
        >
          How?
          <span aria-hidden="true" className="text-tertiary">
            {"›"}
          </span>
        </button>
      </div>
      {showHow && <HowItWorksModal onClose={() => setShowHow(false)} />}
    </Card>
  );
}

const Trophy = (
  <svg
    viewBox="0 0 24 24"
    width="13"
    height="13"
    fill="currentColor"
    aria-hidden="true"
  >
    <path d="M6 2h12v2h3v3a5 5 0 0 1-4.3 4.95A6.01 6.01 0 0 1 13 15.9V18h3v2H8v-2h3v-2.1a6.01 6.01 0 0 1-3.7-3.95A5 5 0 0 1 3 7V4h3V2zm0 4H5v1a3 3 0 0 0 2 2.83V6zm12 0v3.83A3 3 0 0 0 20 7V6h-2z" />
  </svg>
);

function Showcase({ items }: { items: Capture[] }) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [tick, setTick] = useState(0); // restarts the progress animation

  const count = items.length;
  const safeIdx = Math.min(idx, count - 1);

  const go = useCallback(
    (next: number) => {
      setIdx(((next % count) + count) % count);
      setTick((t) => t + 1);
    },
    [count],
  );

  useEffect(() => {
    if (paused || count < 2) return;
    const id = setInterval(() => go(safeIdx + 1), ROTATE_MS);
    return () => clearInterval(id);
  }, [paused, count, safeIdx, go]);

  const c = items[safeIdx];
  const points = c.trends?.dataPoints ?? [];
  const stroke = polarityColor(points);
  const change24h = mock24hChange(c.marketId ?? c.id, c.viralityScore);

  return (
    <Card
      className="relative overflow-hidden flex flex-col lg:h-full"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => {
        // The rotation timer restarts on resume, so restart the bar with it.
        setPaused(false);
        setTick((t) => t + 1);
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,11fr)_minmax(0,10fr)] flex-1 min-h-0">
        {/* image + overlaid history. The capture is shown whole (contain) on
            a blurred copy of itself, so nothing gets cropped. */}
        <Link
          href={`/app/markets/${c.marketId}`}
          className="relative block aspect-[4/3] sm:aspect-auto sm:min-h-[320px] lg:min-h-0 bg-black overflow-hidden"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={`bg-${c.id}`}
            src={c.screenshot}
            alt=""
            aria-hidden="true"
            className="absolute inset-0 w-full h-full object-cover scale-125 blur-2xl opacity-60"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={c.id}
            src={c.screenshot}
            alt=""
            className="absolute inset-0 w-full h-full object-contain p-3"
          />
          <div
            className="absolute inset-x-0 bottom-0 h-[55%]"
            style={{
              background:
                "linear-gradient(to top, rgba(0,0,0,0.85) 0%, rgba(0,0,0,0.4) 55%, rgba(0,0,0,0) 100%)",
            }}
          />
          <div className="absolute inset-x-0 bottom-0 h-[42%]">
            <ViSparkline
              key={c.id}
              dataPoints={points}
              height="100%"
              overlay
              color={stroke}
            />
          </div>
          <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-md bg-black/60 backdrop-blur px-2 py-1 text-[11px] font-bold text-white font-mono">
            {safeIdx === 0 && (
              <span className="text-atnx-yellow">{Trophy}</span>
            )}
            <span className="text-atnx-yellow">#{safeIdx + 1}</span> most viral
          </span>
        </Link>

        {/* details */}
        <div className="p-5 sm:p-6 flex flex-col min-w-0 min-h-0 overflow-hidden">
          <div className="flex items-center gap-1.5 flex-wrap">
            {c.analysis.type && <Chip tone="cyan">{c.analysis.type}</Chip>}
            {c.analysis.category && <Chip>{c.analysis.category}</Chip>}
          </div>
          <Link
            href={`/app/markets/${c.marketId}`}
            className="mt-2 text-xl sm:text-2xl font-bold text-primary leading-tight hover:text-atnx-cyan transition-colors line-clamp-2"
          >
            {c.analysis.name || "Untitled"}
          </Link>

          <div className="mt-4 flex items-end gap-4">
            <div>
              <div className="text-[10px] uppercase tracking-[0.15em] text-tertiary">
                Virality Index
              </div>
              <div className="text-4xl sm:text-5xl font-bold leading-none text-atnx-yellow light:text-atnx-yellow-light mt-1">
                {c.viralityScore}
              </div>
            </div>
            <DeltaChip value={change24h} size="md" className="mb-1" />
          </div>

          {c.analysis.description && (
            <p className="mt-4 text-xs sm:text-sm text-secondary leading-relaxed font-sans line-clamp-3">
              {c.analysis.description}
            </p>
          )}

          <div className="mt-auto pt-5 flex items-center gap-2">
            <Link
              href={`/app/markets/${c.marketId}`}
              className="inline-flex items-center gap-1.5 rounded-full bg-atnx-magenta px-4 py-2 text-xs font-bold text-white hover:bg-atnx-magenta-dim hover:shadow-[0_0_20px_rgba(255,0,229,0.3)] transition-all"
            >
              Trade {"↗"}
            </Link>
            <div className="ml-auto flex items-center gap-1">
              <button
                type="button"
                aria-label="Previous"
                onClick={() => go(safeIdx - 1)}
                className="h-8 w-8 rounded-full border border-surface bg-elevated text-secondary hover:text-primary hover:border-atnx-cyan/50 cursor-pointer transition-colors"
              >
                {"‹"}
              </button>
              <button
                type="button"
                aria-label="Next"
                onClick={() => go(safeIdx + 1)}
                className="h-8 w-8 rounded-full border border-surface bg-elevated text-secondary hover:text-primary hover:border-atnx-cyan/50 cursor-pointer transition-colors"
              >
                {"›"}
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* pager: dots, with the active one stretched into a pill that fills
          over ROTATE_MS */}
      <div
        role="tablist"
        aria-label="Featured markets"
        className="flex items-center justify-center gap-2 py-3 border-t border-surface"
      >
        {items.map((it, i) => {
          const active = i === safeIdx;
          return (
            <button
              key={it.id}
              role="tab"
              type="button"
              aria-selected={active}
              aria-label={`${i + 1}. ${it.analysis.name ?? "market"}`}
              onClick={() => go(i)}
              className={`relative h-1.5 rounded-full overflow-hidden cursor-pointer transition-all duration-300 ${
                active
                  ? "w-8 bg-elevated"
                  : "w-1.5 bg-elevated hover:bg-secondary/40"
              }`}
            >
              {active && (
                <span
                  key={tick}
                  className="absolute inset-y-0 left-0 rounded-full bg-atnx-cyan animate-hero-progress"
                  style={{
                    animationDuration: `${ROTATE_MS}ms`,
                    animationPlayState: paused ? "paused" : "running",
                  }}
                />
              )}
            </button>
          );
        })}
      </div>
    </Card>
  );
}
