"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ViSparkline, polarityColor } from "@/components/charts/ViArea";
import { Card, Chip, DeltaChip } from "@/components/ui";
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
    <section className="grid grid-cols-1 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] gap-4 mb-8">
      <Intro />
      {featured.length > 0 && <Showcase items={featured} />}
    </section>
  );
}

function Intro() {
  return (
    <Card className="relative overflow-hidden p-5 sm:p-6 flex flex-col justify-between min-h-[260px]">
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
        <div className="text-[10px] uppercase tracking-[0.2em] text-tertiary mb-2">
          Attention Exchange
        </div>
        <h2 className="text-2xl sm:text-3xl font-bold text-primary tracking-tight leading-tight">
          Trade attention,
          <br />
          not tokens.
        </h2>
        <ol className="mt-5 space-y-3">
          {[
            {
              n: "1",
              tone: "cyan" as const,
              title: "Capture anything",
              body: (
                <>
                  Hit{" "}
                  <kbd className="rounded border border-surface bg-elevated px-1 py-0.5 text-[10px] text-secondary font-mono">
                    Ctrl+Shift+X
                  </kbd>{" "}
                  on any page. Claude identifies the meme, person or moment and
                  spawns a market for it.
                </>
              ),
            },
            {
              n: "2",
              tone: "yellow" as const,
              title: "Watch the Virality Index",
              body: "A live 0 to 1000 score of how much attention something is getting, updated with every capture.",
            },
            {
              n: "3",
              tone: "magenta" as const,
              title: "Take a side",
              body: "Long if you think attention climbs, short if it fades. Simulated USDC, real bragging rights.",
            },
          ].map((s) => (
            <li key={s.n} className="flex gap-3">
              <span
                className={`h-6 w-6 shrink-0 rounded-md inline-flex items-center justify-center text-[11px] font-bold font-mono border ${
                  s.tone === "cyan"
                    ? "bg-atnx-cyan/10 text-atnx-cyan light:text-atnx-cyan-light border-atnx-cyan/25"
                    : s.tone === "yellow"
                      ? "bg-atnx-yellow/10 text-atnx-yellow light:text-atnx-yellow-light border-atnx-yellow/25"
                      : "bg-atnx-magenta/10 text-atnx-magenta light:text-atnx-magenta-light border-atnx-magenta/25"
                }`}
              >
                {s.n}
              </span>
              <div className="min-w-0">
                <div className="text-sm font-bold text-primary">{s.title}</div>
                <p className="text-xs text-secondary leading-relaxed font-sans mt-0.5">
                  {s.body}
                </p>
              </div>
            </li>
          ))}
        </ol>
      </div>
      <div className="relative mt-5 flex items-center gap-2 text-[11px] text-tertiary">
        <a
          href="#all-markets"
          className="rounded-full border border-surface bg-elevated px-3 py-1.5 font-bold text-primary hover:border-atnx-cyan/50 transition-colors"
        >
          Browse all markets
        </a>
        <span>or pick one on the right.</span>
      </div>
    </Card>
  );
}

function Showcase({ items }: { items: Capture[] }) {
  const [idx, setIdx] = useState(0);
  const [paused, setPaused] = useState(false);
  const [tick, setTick] = useState(0); // restarts the progress bar animation

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
      className="relative overflow-hidden flex flex-col"
      onMouseEnter={() => setPaused(true)}
      onMouseLeave={() => {
        // The rotation timer restarts on resume, so restart the bar with it.
        setPaused(false);
        setTick((t) => t + 1);
      }}
    >
      <div className="grid grid-cols-1 sm:grid-cols-[minmax(0,5fr)_minmax(0,6fr)] flex-1">
        {/* image + overlaid history */}
        <Link
          href={`/app/markets/${c.marketId}`}
          className="relative block aspect-[4/3] sm:aspect-auto sm:min-h-[300px] bg-black overflow-hidden"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            key={c.id}
            src={c.screenshot}
            alt=""
            className="absolute inset-0 w-full h-full object-cover"
          />
          <div
            className="absolute inset-x-0 bottom-0 h-[62%]"
            style={{
              background:
                "linear-gradient(to top, rgba(0,0,0,0.88) 0%, rgba(0,0,0,0.45) 55%, rgba(0,0,0,0) 100%)",
            }}
          />
          <div className="absolute inset-x-0 bottom-0 h-[48%]">
            <ViSparkline
              key={c.id}
              dataPoints={points}
              height="100%"
              overlay
              color={stroke}
            />
          </div>
          <span className="absolute top-3 left-3 inline-flex items-center gap-1.5 rounded-md bg-black/60 backdrop-blur px-2 py-1 text-[11px] font-bold text-white font-mono">
            <span className="text-atnx-yellow">#{safeIdx + 1}</span> most viral
          </span>
        </Link>

        {/* details */}
        <div className="p-5 sm:p-6 flex flex-col min-w-0">
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

      {/* pager: one segment per featured market, the active one fills over ROTATE_MS */}
      <div
        role="tablist"
        aria-label="Featured markets"
        className="flex gap-1.5 px-4 py-3 border-t border-surface"
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
              className="relative h-1.5 flex-1 rounded-full bg-elevated overflow-hidden cursor-pointer"
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
