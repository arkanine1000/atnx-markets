"use client";

import { useEffect, useId, useRef, useState } from "react";
import { DOWN, UP } from "@/components/charts/ViArea";

// Portfolio value over a window, drawn the way the extension's side panel
// draws it: a monotone line over a soft wash, a dashed hairline at the
// window's starting value, an end marker, and a crosshair with a tooltip
// on touch or hover. One series, so colour carries polarity only.

export interface ValuePoint {
  t: string;
  value: number;
}

const PAD_Y = 6;
// The y-axis never spans less than this share of the portfolio, so a $20
// wobble on $10k reads as a ripple rather than a cliff.
const MIN_SPAN_RATIO = 0.02;

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 2,
});

const px = (n: number) => n.toFixed(1);

// Monotone cubic interpolation (Fritsch–Carlson): rounds the corners between
// samples without overshooting, so smoothing never invents a peak or a dip.
function monotonePath(pts: { x: number; y: number }[]): string {
  const n = pts.length;
  if (n < 3) return pts.map((p, i) => `${i ? "L" : "M"}${px(p.x)},${px(p.y)}`).join(" ");
  const dx: number[] = [];
  const slope: number[] = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1].x - pts[i].x;
    slope[i] = dx[i] > 0 ? (pts[i + 1].y - pts[i].y) / dx[i] : 0;
  }
  const tangent: number[] = new Array(n);
  tangent[0] = slope[0];
  tangent[n - 1] = slope[n - 2];
  for (let i = 1; i < n - 1; i++) {
    tangent[i] = slope[i - 1] * slope[i] <= 0 ? 0 : (slope[i - 1] + slope[i]) / 2;
  }
  for (let i = 0; i < n - 1; i++) {
    if (slope[i] === 0) {
      tangent[i] = 0;
      tangent[i + 1] = 0;
      continue;
    }
    const a = tangent[i] / slope[i];
    const b = tangent[i + 1] / slope[i];
    const s = a * a + b * b;
    if (s > 9) {
      const k = 3 / Math.sqrt(s);
      tangent[i] = k * a * slope[i];
      tangent[i + 1] = k * b * slope[i];
    }
  }
  let d = `M${px(pts[0].x)},${px(pts[0].y)}`;
  for (let i = 0; i < n - 1; i++) {
    const h = dx[i] / 3;
    d +=
      ` C${px(pts[i].x + h)},${px(pts[i].y + h * tangent[i])}` +
      ` ${px(pts[i + 1].x - h)},${px(pts[i + 1].y - h * tangent[i + 1])}` +
      ` ${px(pts[i + 1].x)},${px(pts[i + 1].y)}`;
  }
  return d;
}

export function PortfolioSparkline({
  points,
  height = 72,
  formatTime,
  className = "",
}: {
  points: ValuePoint[];
  // Pixels, or "fill" to take the height its container gives it.
  height?: number | "fill";
  formatTime: (t: Date) => string;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [w, setW] = useState(0);
  const [fillH, setFillH] = useState(0);
  const fill = height === "fill";
  const [hover, setHover] = useState<number>(-1);
  const gradId = useId();

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const width = Math.floor(entries[0]?.contentRect.width ?? 0);
      const tall = Math.floor(entries[0]?.contentRect.height ?? 0);
      setW((prev) => (prev === width ? prev : width));
      setFillH((prev) => (prev === tall ? prev : tall));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const h = fill ? fillH : height;
  const values = points.map((p) => p.value);
  const ready = w > 0 && h > PAD_Y * 2 && points.length >= 2;

  let plotted: { x: number; y: number; t: number; value: number }[] = [];
  let color = UP;
  if (ready) {
    const first = values[0];
    const lastValue = values[values.length - 1];
    let min = Math.min(...values);
    let max = Math.max(...values);
    const floor = Math.max(Math.abs(lastValue) * MIN_SPAN_RATIO, 1);
    if (max - min < floor) {
      const mid = (max + min) / 2;
      min = mid - floor / 2;
      max = mid + floor / 2;
    }
    const pad = (max - min) * 0.08;
    min -= pad;
    max += pad;
    color = lastValue >= first ? UP : DOWN;
    const t0 = new Date(points[0].t).getTime();
    const t1 = new Date(points[points.length - 1].t).getTime();
    const span = Math.max(1, t1 - t0);
    plotted = points.map((p) => {
      const t = new Date(p.t).getTime();
      return {
        x: ((t - t0) / span) * w,
        y: PAD_Y + (1 - (p.value - min) / (max - min)) * (h - PAD_Y * 2),
        t,
        value: p.value,
      };
    });
  }

  const line = ready ? monotonePath(plotted) : "";
  const last = plotted[plotted.length - 1];
  const hov = hover >= 0 ? plotted[Math.min(hover, plotted.length - 1)] : undefined;

  function nearest(clientX: number) {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect || !plotted.length) return -1;
    const x = clientX - rect.left;
    let best = 0;
    let bestD = Infinity;
    plotted.forEach((p, i) => {
      const d = Math.abs(p.x - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    });
    return best;
  }

  return (
    <div
      ref={ref}
      style={fill ? undefined : { height: h }}
      className={`relative w-full select-none touch-pan-y ${fill ? "h-full" : ""} ${className}`}
      onPointerMove={(e) => setHover(nearest(e.clientX))}
      onPointerDown={(e) => setHover(nearest(e.clientX))}
      onPointerLeave={() => setHover(-1)}
      onPointerUp={() => setHover(-1)}
      onPointerCancel={() => setHover(-1)}
    >
      {ready ? (
        <svg
          viewBox={`0 0 ${w} ${h}`}
          width={w}
          height={h}
          className="block overflow-visible"
          aria-hidden="true"
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={color} stopOpacity={0.18} />
              <stop offset="100%" stopColor={color} stopOpacity={0} />
            </linearGradient>
          </defs>
          <path
            d={`${line} L${px(last.x)},${h} L${px(plotted[0].x)},${h} Z`}
            fill={`url(#${gradId})`}
          />
          <line
            x1={0}
            x2={w}
            y1={px(plotted[0].y)}
            y2={px(plotted[0].y)}
            stroke="currentColor"
            className="text-tertiary/50"
            strokeWidth={1}
            strokeDasharray="3 3"
          />
          <path
            d={line}
            fill="none"
            stroke={color}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
          />
          <circle cx={last.x} cy={last.y} r={5.5} className="fill-[var(--color-dark-surface)] light:fill-white" />
          <circle cx={last.x} cy={last.y} r={4} fill={color} />
          {hov && (
            <g>
              <line x1={hov.x} x2={hov.x} y1={0} y2={h} stroke="#8A8A8A" strokeWidth={1} />
              <circle cx={hov.x} cy={hov.y} r={6} className="fill-[var(--color-dark-surface)] light:fill-white" />
              <circle cx={hov.x} cy={hov.y} r={4} fill="currentColor" className="text-primary" />
            </g>
          )}
        </svg>
      ) : (
        <div className="h-full flex items-center justify-center text-[11px] text-tertiary">
          {points.length < 2 ? "No history yet" : ""}
        </div>
      )}
      {hov && (
        <div
          className="pointer-events-none absolute top-0 -translate-x-1/2 rounded-md border border-surface bg-elevated px-2 py-1 text-[11px] leading-tight whitespace-nowrap"
          style={{ left: Math.min(Math.max(hov.x, 48), Math.max(48, w - 48)) }}
        >
          <div className="font-bold text-primary text-xs">{usd.format(hov.value)}</div>
          <div className="text-tertiary">{formatTime(new Date(hov.t))}</div>
        </div>
      )}
    </div>
  );
}
