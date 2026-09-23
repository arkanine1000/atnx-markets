"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState } from "react";
import { ViSparkline, deltaColor } from "@/components/charts/ViArea";
import { LogoImage } from "@/components/LogoImage";
import { tileImage } from "@/components/MarketCard";
import { Card, Chip, DeltaChip } from "@/components/ui";
import { HowItWorksModal } from "@/components/HowItWorksModal";
import { viChange24h } from "@/lib/capture-view";
import type { Capture } from "@/lib/store";

const ROTATE_MS = 6000;
const FEATURED = 5;

// Polymarket-style top row: what the platform is on the left, and a large
// auto-rotating showcase of the most viral markets on the right.
export function FeaturedHero({ captures }: { captures: Capture[] }) {
  // One slide per market: the feed lists every capture, newest first, and
  // a market captured twice would otherwise appear twice.
  const featured = useMemo(() => {
    const seen = new Set<string>();
    return captures
      .filter((c) => c.marketId && !seen.has(c.marketId) && seen.add(c.marketId))
      .sort((a, b) => b.viralityScore - a.viralityScore)
      .slice(0, FEATURED);
  }, [captures]);

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

// CMYK outline CTA. A thin gradient ring (the gradient is painted on a
// ::before and masked to the border), faded at rest with a soft glow and
// brought up to full on hover / focus; it never fills. The gradient is
// cyan / magenta / yellow blocks with 3% seams rather than a smooth blend,
// because blending yellow into cyan passes through green and cyan into
// magenta through blue. It's twice the button's width and slides across it
// so the colours keep changing; the last stop repeats the first so the loop
// is seamless. Static under reduced motion. Lives with the component (not
// globals.css) so it can never be stale or stripped relative to the markup
// it styles.
const BTN_CSS = `
@keyframes cmyk-shift {
  from { background-position: 0% 50%; }
  to { background-position: 200% 50%; }
}
.btn-cmyk {
  position: relative;
  isolation: isolate;
  color: rgba(255, 255, 255, 0.85);
  background: transparent;
  box-shadow: 0 0 12px rgba(255, 0, 229, 0.12), 0 0 24px rgba(0, 212, 255, 0.08);
  transition: color 0.25s ease, box-shadow 0.3s ease;
}
.light .btn-cmyk { color: rgba(10, 10, 10, 0.85); }
.btn-cmyk::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: -1;
  border-radius: inherit;
  padding: 1.5px;
  opacity: 0.6;
  background-image: linear-gradient(90deg,
    #00D4FF 0%, #00D4FF 30%,
    #FF00E5 33%, #FF00E5 63%,
    #FFE500 66%, #FFE500 97%,
    #00D4FF 100%);
  background-size: 200% 100%;
  animation: cmyk-shift 6s linear infinite;
  -webkit-mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  mask: linear-gradient(#000 0 0) content-box, linear-gradient(#000 0 0);
  -webkit-mask-composite: xor;
  mask-composite: exclude;
  transition: opacity 0.25s ease;
}
.btn-cmyk:hover, .btn-cmyk:focus-visible {
  color: #FFFFFF;
  box-shadow: 0 0 16px rgba(255, 0, 229, 0.22), 0 0 32px rgba(0, 212, 255, 0.14);
}
.light .btn-cmyk:hover, .light .btn-cmyk:focus-visible { color: #0A0A0A; }
.btn-cmyk:hover::before, .btn-cmyk:focus-visible::before { opacity: 1; }
@media (prefers-reduced-motion: reduce) {
  .btn-cmyk::before { animation: none; }
}
`;

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
        <h2 className="font-display text-3xl sm:text-4xl font-bold text-primary tracking-tight leading-tight">
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
        <style>{BTN_CSS}</style>
        <button
          type="button"
          onClick={() => setShowHow(true)}
          className="btn-cmyk mt-7 inline-flex items-center gap-1.5 rounded-full px-[18px] py-[9px] text-[13px] font-bold cursor-pointer"
        >
          Show Me
          <span aria-hidden="true" className="opacity-60">
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
  const change24h = viChange24h(points, c.viralityScore);
  const stroke = deltaColor(change24h);
  // Curated market image when one has been found, else the capture. A logo
  // sits on a light ground instead of a blurred copy of itself.
  const image = tileImage(c);

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
          // Wider than tall on phones so the name and score sit within
          // the first screen instead of a scroll below the image.
          className="relative block aspect-[16/10] sm:aspect-auto sm:min-h-[320px] lg:min-h-0 bg-black overflow-hidden"
        >
          {image.logo ? (
            <LogoImage key={c.id} src={image.src} imgClassName="p-[10%] pb-[36%]" />
          ) : (
            <>
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                key={`bg-${c.id}`}
                src={image.src}
                alt=""
                aria-hidden="true"
                className="absolute inset-0 w-full h-full object-cover scale-125 blur-2xl opacity-60"
              />
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img
                key={c.id}
                src={image.src}
                alt=""
                className="absolute inset-0 w-full h-full object-contain p-3"
              />
            </>
          )}
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

          <div className="mt-4">
            <div className="text-[10px] font-mono uppercase tracking-[0.15em] text-tertiary">
              Virality Index
            </div>
            <div className="mt-1 flex items-baseline gap-2.5">
              <span className="font-display text-4xl sm:text-5xl font-bold leading-none tabular-nums text-atnx-yellow light:text-atnx-yellow-light">
                {c.viralityScore}
              </span>
              <DeltaChip value={change24h} size="md" />
            </div>
          </div>

          {(c.marketDescription || c.analysis.description) && (
            <p className="mt-4 text-xs sm:text-sm text-secondary leading-relaxed font-sans line-clamp-3">
              {c.marketDescription || c.analysis.description}
            </p>
          )}

          <div className="mt-auto pt-5 flex items-center gap-2">
            <Link
              href={`/app/markets/${c.marketId}`}
              className="inline-flex items-center gap-1.5 rounded-full btn-magenta px-4 py-2 text-xs font-bold"
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
