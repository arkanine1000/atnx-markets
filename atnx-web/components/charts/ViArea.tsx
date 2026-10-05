"use client";

import { useEffect, useId, useMemo, useRef, useState, type ComponentProps } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceDot,
  ReferenceLine,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { useTheme } from "next-themes";

// Virality Index over time, drawn as a 2px line over a soft gradient wash.
// One series, so colour carries polarity only: cyan when the visible range
// ends higher than it starts, magenta when lower (the app's up/down pair).

export interface ViPoint {
  date: string;
  value: number;
}

export const UP = "#00D4FF";
export const DOWN = "#FF00E5";
// The round target: neither side's colour, the index's own yellow (the
// darker one on the light theme, where #FFE500 on white does not read).
const TARGET = "#FFE500";
const TARGET_LIGHT = "#D4BE00";

export function polarityColor(points: ViPoint[]): string {
  if (points.length < 2) return UP;
  return points[points.length - 1].value >= points[0].value ? UP : DOWN;
}

// Colour for a sparkline that sits beside a DeltaChip: the line follows the
// same 24h delta as the chip, so the two never disagree. Cyan when there is
// no delta to show, matching the chip's neutral state leaning up.
export function deltaColor(change: number | null): string {
  return change !== null && change < 0 ? DOWN : UP;
}

// Measure the wrapper ourselves and hand recharts explicit pixel dimensions.
// Its ResponsiveContainer starts at -1×-1 and logs a warning on the first
// paint; sizing the chart directly avoids that and a hidden wrapper simply
// draws nothing.
function useSize() {
  const ref = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ w: 0, h: 0 });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      const r = entries[0]?.contentRect;
      if (!r) return;
      const w = Math.floor(r.width);
      const h = Math.floor(r.height);
      setSize((prev) => (prev.w === w && prev.h === h ? prev : { w, h }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  return { ref, w: size.w, h: size.h, ready: size.w > 0 && size.h > 0 };
}

function useChartTheme() {
  const { resolvedTheme } = useTheme();
  const light = resolvedTheme === "light";
  return {
    light,
    surface: light ? "#FFFFFF" : "#141414",
    grid: light ? "#ECECEC" : "#232323",
    tick: light ? "#8A8A8A" : "#6A6A6A",
    tooltipBg: light ? "#FFFFFF" : "#1E1E1E",
    tooltipBorder: light ? "#E0E0E0" : "#2A2A2A",
    ink: light ? "#0A0A0A" : "#F0F0F0",
    inkMuted: light ? "#555555" : "#999999",
  };
}

// ---------------------------------------------------------------------------
// Sparkline: no axes, no chrome. `overlay` is for drawing on top of an image
// (stronger wash, no vertical padding) as on the market cards.

export function ViSparkline({
  dataPoints,
  height = 40,
  overlay = false,
  color,
  className = "",
}: {
  dataPoints: ViPoint[];
  height?: number | string;
  overlay?: boolean;
  color?: string;
  className?: string;
}) {
  const data = dataPoints;
  const { ref, w, h, ready } = useSize();
  const gradId = useId();
  const stroke = color ?? polarityColor(data);

  if (data.length < 2) {
    if (overlay) return null;
    return (
      <div
        ref={ref}
        style={{ height }}
        className={`flex items-center justify-center text-[10px] text-tertiary ${className}`}
      >
        no history
      </div>
    );
  }

  return (
    <div ref={ref} style={{ height }} className={`w-full ${className}`}>
      {ready && (
        <AreaChart
          width={w}
          height={h}
          data={data}
          // Recharts 3 makes the chart focusable by default, which drew the
          // browser's focus ring around it on every tap. Nothing here is
          // keyboard-driven: the sparkline is decoration and the market
          // chart's tooltip follows the pointer. Its wrapper also sets
          // cursor: default inline; inherit keeps the card link's pointer.
          accessibilityLayer={false}
          style={{ cursor: "inherit" }}
          margin={{ top: overlay ? 2 : 4, right: 0, bottom: 0, left: 0 }}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop
                offset="0%"
                stopColor={stroke}
                stopOpacity={overlay ? 0.45 : 0.28}
              />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <YAxis domain={["auto", "auto"]} hide />
          <Area
            type="monotone"
            dataKey="value"
            stroke={stroke}
            strokeWidth={overlay ? 2 : 1.75}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill={`url(#${gradId})`}
            dot={false}
            activeDot={false}
            isAnimationActive={false}
          />
        </AreaChart>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Full chart for the market page: range tabs, hairline grid, right-hand ticks
// (Trendle-style), crosshair tooltip, and the two bounds of the open
// UP/DOWN market drawn as lines the VI has to reach.

export type Range = "1H" | "4H" | "1D" | "1W" | "1M" | "ALL";
export const RANGES: Range[] = ["1H", "4H", "1D", "1W", "1M", "ALL"];
const RANGE_MS: Record<Range, number> = {
  "1H": 3600e3,
  "4H": 4 * 3600e3,
  "1D": 24 * 3600e3,
  "1W": 7 * 24 * 3600e3,
  "1M": 30 * 24 * 3600e3,
  ALL: Infinity,
};

export function sliceRange(
  points: ViPoint[],
  range: Range,
  now = Date.now(),
): ViPoint[] {
  if (range === "ALL") return points;
  const cutoff = now - RANGE_MS[range];
  return points.filter((p) => new Date(p.date).getTime() >= cutoff);
}

function fmtTime(iso: string, range: Range): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  if (range === "1H" || range === "4H" || range === "1D") {
    return d.toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  }
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fmtFull(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

interface TooltipPayload {
  active?: boolean;
  payload?: ReadonlyArray<{ payload?: ViPoint }>;
}

export function ViChart({
  dataPoints,
  range,
  height = 280,
  bounds,
  target,
  marks = [],
  scoring = false,
}: {
  dataPoints: ViPoint[];
  range: Range;
  height?: number;
  /** Bounds of the open bounded market: UP pays at `upper`, DOWN at `lower`. */
  bounds?: { lower: number; upper: number } | null;
  /** The live round's target: UP wins if the index ends at or above it. */
  target?: { value: number; label: string } | null;
  /** The viewer's own trades, drawn as dots at the nearest VI print; `label` is the hover text. */
  marks?: Array<{ time: number; side: "up" | "down"; kind: "buy" | "sell"; label?: string }>;
  /** The market has no VI yet; the empty chart says so instead of blaming the range. */
  scoring?: boolean;
}) {
  const data = useMemo(() => sliceRange(dataPoints, range), [dataPoints, range]);
  // Each trade lands on the visible print closest to its block time; trades
  // outside the visible range are left out.
  const markDots = useMemo(() => {
    if (!marks.length || data.length < 2) return [];
    const times = data.map((p) => new Date(p.date).getTime());
    const first = times[0];
    const last = times[times.length - 1];
    return marks
      .filter((m) => m.time >= first - 300_000 && m.time <= last + 300_000)
      .map((m, i) => {
        let best = 0;
        let bestDist = Infinity;
        times.forEach((tt, j) => {
          const d = Math.abs(tt - m.time);
          if (d < bestDist) {
            bestDist = d;
            best = j;
          }
        });
        return { key: `${m.time}-${i}`, x: data[best].date, y: data[best].value, side: m.side, kind: m.kind, label: m.label };
      });
  }, [marks, data]);
  // The hovered trade dot: its pixel position and text, for the tooltip
  // drawn over the chart (recharts' own tooltip follows the series only).
  const [hover, setHover] = useState<{ cx: number; cy: number; text: string } | null>(null);
  // Where recharts drew each dot, filled in by the shape callback below.
  const dotPx = useRef(new Map<string, { cx: number; cy: number }>());
  const t = useChartTheme();
  const { ref, w, h, ready } = useSize();
  // The hit test runs on the chart's own mouse move rather than on the
  // dot's SVG events: recharts' active dot, cursor and curve sit on top
  // of the trade marks and swallow the pointer. The target is a 40px box
  // around each dot, not a 10px circle.
  const HIT = 20;
  const onChartMove: NonNullable<ComponentProps<typeof AreaChart>["onMouseMove"]> = (_state, e) => {
    const rect = ref.current?.getBoundingClientRect();
    if (!rect) return;
    const x = e.clientX - rect.left;
    const y = e.clientY - rect.top;
    let found: { cx: number; cy: number; text: string } | null = null;
    let best = Infinity;
    for (const m of markDots) {
      const px = dotPx.current.get(m.key);
      if (!px) continue;
      const dx = Math.abs(px.cx - x);
      const dy = Math.abs(px.cy - y);
      if (dx > HIT || dy > HIT) continue;
      const d = dx * dx + dy * dy;
      if (d < best) {
        best = d;
        found = { cx: px.cx, cy: px.cy, text: m.label ?? `${m.kind === "buy" ? "Bought" : "Sold"} ${m.side.toUpperCase()}` };
      }
    }
    setHover((h) => (h?.cx === found?.cx && h?.cy === found?.cy && h?.text === found?.text ? h : found));
  };
  const gradId = useId();
  const stroke = polarityColor(data);

  if (data.length < 2) {
    return (
      <div
        style={{ height }}
        className="flex flex-col items-center justify-center gap-1 text-tertiary text-xs"
      >
        {scoring ? (
          <>
            <span className="font-mono uppercase tracking-[0.12em] text-secondary animate-pulse">
              Scoring…
            </span>
            <span className="text-[11px]">The chart starts with the first score.</span>
          </>
        ) : (
          <>
            <span>Not enough history for this range.</span>
            <span className="text-[11px]">Try a wider range.</span>
          </>
        )}
      </div>
    );
  }

  return (
    <div ref={ref} style={{ height }} className="w-full relative">
      {hover && (
        <div
          className="absolute z-10 pointer-events-none rounded-lg px-2.5 py-1.5 text-[11px] font-sans shadow-lg whitespace-nowrap -translate-x-1/2"
          style={{
            left: hover.cx,
            top: Math.max(0, hover.cy - 44),
            background: t.tooltipBg,
            border: `1px solid ${t.tooltipBorder}`,
            color: t.ink,
          }}
        >
          {hover.text}
        </div>
      )}
      {ready && (
        <AreaChart
          width={w}
          height={h}
          data={data}
          accessibilityLayer={false}
          style={{ cursor: hover ? "pointer" : "inherit" }}
          margin={{ top: 12, right: 8, bottom: 0, left: 0 }}
          onMouseMove={onChartMove}
          onMouseLeave={() => setHover(null)}
        >
          <defs>
            <linearGradient id={gradId} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={stroke} stopOpacity={0.3} />
              <stop offset="100%" stopColor={stroke} stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid vertical={false} stroke={t.grid} strokeWidth={1} />
          <XAxis
            dataKey="date"
            tickFormatter={(v: string) => fmtTime(v, range)}
            tick={{ fill: t.tick, fontSize: 11, fontFamily: "inherit" }}
            tickLine={false}
            axisLine={false}
            minTickGap={48}
            interval="preserveStartEnd"
            height={28}
          />
          {/* Anchored at zero: the Virality Index is a level with a
              floor of 0, and a domain fitted to the data draws a steady
              438 along the bottom edge as if the market were dead. */}
          <YAxis
            orientation="right"
            domain={[0, "auto"]}
            tick={{ fill: t.tick, fontSize: 11, fontFamily: "inherit" }}
            tickLine={false}
            axisLine={false}
            width={44}
            tickFormatter={(v: number) => String(Math.round(v))}
          />
          <Tooltip
            cursor={{ stroke: t.tick, strokeWidth: 1 }}
            isAnimationActive={false}
            content={({ active, payload }: TooltipPayload) => {
              const p = payload?.[0]?.payload;
              if (!active || !p) return null;
              return (
                <div
                  className="rounded-lg px-3 py-2 shadow-lg font-mono"
                  style={{
                    background: t.tooltipBg,
                    border: `1px solid ${t.tooltipBorder}`,
                  }}
                >
                  <div className="flex items-center gap-2">
                    <span
                      aria-hidden="true"
                      className="inline-block w-3 h-0.5 rounded-full"
                      style={{ background: stroke }}
                    />
                    <span
                      className="text-base font-bold"
                      style={{ color: t.ink }}
                    >
                      {Math.round(p.value)}
                    </span>
                    <span
                      className="text-[10px] font-mono uppercase tracking-wider"
                      style={{ color: t.inkMuted }}
                    >
                      VI
                    </span>
                  </div>
                  <div
                    className="text-[11px] mt-0.5"
                    style={{ color: t.inkMuted }}
                  >
                    {fmtFull(p.date)}
                  </div>
                </div>
              );
            }}
          />
          <Area
            type="monotone"
            dataKey="value"
            stroke={stroke}
            strokeWidth={2}
            strokeLinejoin="round"
            strokeLinecap="round"
            fill={`url(#${gradId})`}
            dot={false}
            activeDot={{
              r: 4,
              fill: stroke,
              stroke: t.surface,
              strokeWidth: 2,
            }}
            isAnimationActive={false}
          />
          {/* The bounds: where UP and DOWN pay. The domain stretches to
              include them so the distance the VI still has to travel is
              visible; a lower bound of 0 is the axis itself. */}
          {bounds && (
            <ReferenceLine
              y={bounds.upper}
              stroke={UP}
              strokeWidth={1}
              strokeDasharray="4 3"
              strokeOpacity={0.7}
              ifOverflow="extendDomain"
              label={{
                value: `UP PAYS @ ${bounds.upper}`,
                position: "insideTopLeft",
                fill: UP,
                fontSize: 10,
                fontWeight: 700,
              }}
            />
          )}
          {/* The live round's target, the VI it opened at. The domain
              stretches to include it, like the bounds. */}
          {target && (
            <ReferenceLine
              y={target.value}
              stroke={t.light ? TARGET_LIGHT : TARGET}
              strokeWidth={1}
              strokeDasharray="4 3"
              strokeOpacity={0.8}
              ifOverflow="extendDomain"
              label={{
                value: target.label,
                position: "insideTopLeft",
                fill: t.light ? TARGET_LIGHT : TARGET,
                fontSize: 10,
                fontWeight: 700,
              }}
            />
          )}
          {markDots.map((m) => {
            const color = m.side === "up" ? UP : DOWN;
            const fill = m.kind === "buy" ? color : t.surface;
            const text = m.label ?? `${m.kind === "buy" ? "Bought" : "Sold"} ${m.side.toUpperCase()}`;
            return (
              <ReferenceDot
                key={m.key}
                x={m.x}
                y={m.y}
                r={4.5}
                ifOverflow="visible"
                shape={(props: { cx?: number; cy?: number }) => {
                  const cx = props.cx ?? 0;
                  const cy = props.cy ?? 0;
                  dotPx.current.set(m.key, { cx, cy });
                  const lit = hover?.cx === cx && hover?.cy === cy;
                  return (
                    <circle cx={cx} cy={cy} r={lit ? 6.5 : 5} fill={fill} stroke={color} strokeWidth={2} pointerEvents="none">
                      <title>{text}</title>
                    </circle>
                  );
                }}
              />
            );
          })}
          {bounds && bounds.lower > 0 && (
            <ReferenceLine
              y={bounds.lower}
              stroke={DOWN}
              strokeWidth={1}
              strokeDasharray="4 3"
              strokeOpacity={0.7}
              ifOverflow="extendDomain"
              label={{
                value: `DOWN PAYS @ ${bounds.lower}`,
                position: "insideBottomLeft",
                fill: DOWN,
                fontSize: 10,
                fontWeight: 700,
              }}
            />
          )}
        </AreaChart>
      )}
    </div>
  );
}
