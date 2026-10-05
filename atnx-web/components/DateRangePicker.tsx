"use client";

import { useEffect, useId, useMemo, useRef, useState } from "react";

// A calendar for picking the window a chart shows, the way CoinGecko's
// chart does it: a calendar button beside the range tabs opens one month,
// the first tap marks the start, the second the end, and the chart redraws
// for exactly those days. Days the chart has no data for are greyed out.
//
// The picked window is a pair of instants: the start of the first day and
// the end of the last one, in the viewer's own time zone, so "Sep 8 – Sep
// 24" means the whole of both days wherever the viewer is.

export interface DateRange {
  /** Epoch ms, the start of the first day. */
  from: number;
  /** Epoch ms, the end of the last day (or now, when the last day is today). */
  to: number;
}

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

const monthTitle = new Intl.DateTimeFormat(undefined, {
  month: "long",
  year: "numeric",
});
const dayLabel = new Intl.DateTimeFormat(undefined, {
  weekday: "long",
  month: "long",
  day: "numeric",
  year: "numeric",
});
const shortDay = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
});
const shortDayYear = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  year: "numeric",
});

function startOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function endOfDay(t: number): number {
  const d = new Date(t);
  d.setHours(23, 59, 59, 999);
  return d.getTime();
}

/** The window for two picked days, in either order, clipped to now. */
export function dayRange(a: number, b: number, now = Date.now()): DateRange {
  const [lo, hi] = a <= b ? [a, b] : [b, a];
  return { from: startOfDay(lo), to: Math.min(endOfDay(hi), now) };
}

/** "Sep 8 – Sep 24", with the year once it is not this one. */
export function formatDateRange(range: DateRange, now = Date.now()): string {
  const thisYear = new Date(now).getFullYear();
  const from = new Date(range.from);
  const to = new Date(range.to);
  const fmt =
    from.getFullYear() === thisYear && to.getFullYear() === thisYear
      ? shortDay
      : shortDayYear;
  if (startOfDay(range.from) === startOfDay(range.to)) return fmt.format(from);
  return `${fmt.format(from)} – ${fmt.format(to)}`;
}

// The six rows of a month view: the days of `month` padded with the
// neighbouring months' days so every row has seven cells.
function monthGrid(year: number, month: number): { t: number; inMonth: boolean }[] {
  const first = new Date(year, month, 1);
  const lead = first.getDay();
  const cells: { t: number; inMonth: boolean }[] = [];
  for (let i = -lead; cells.length < 42; i++) {
    const d = new Date(year, month, 1 + i);
    cells.push({ t: d.getTime(), inMonth: d.getMonth() === month });
  }
  return cells;
}

function CalendarIcon({ className = "" }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      className={className}
    >
      <rect x="3" y="5" width="18" height="16" rx="2" />
      <path d="M16 3v4M8 3v4M3 10h18" />
    </svg>
  );
}

function Chevron({ dir }: { dir: "left" | "right" }) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={14}
      height={14}
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={dir === "left" ? "M15 6l-6 6 6 6" : "M9 6l6 6-6 6"} />
    </svg>
  );
}

export function DateRangePicker({
  value,
  onChange,
  min,
  maxSpanMs,
  max,
  disabled = false,
  align = "right",
  className = "",
}: {
  /** The custom window in force, or null when a preset tab is active. */
  value: DateRange | null;
  /** A complete pick (both ends), or null when the viewer clears it. */
  onChange: (range: DateRange | null) => void;
  /** Earliest day with data (epoch ms). Days before it cannot be picked. */
  min?: number;
  /** How far back from today the calendar reaches, when `min` is not known. */
  maxSpanMs?: number;
  /** Latest pickable day (epoch ms); defaults to today. */
  max?: number;
  disabled?: boolean;
  /** Which edge of the button the calendar hangs from. */
  align?: "left" | "right";
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  // The first end of a pick in progress, and the day under the pointer so
  // the span previews before the second tap.
  const [anchor, setAnchor] = useState<number | null>(null);
  const [hover, setHover] = useState<number | null>(null);
  // The moment the calendar was opened: "today" and the far edge of the
  // pickable days are fixed then, not re-read on every render.
  const [clock, setClock] = useState(0);
  const [view, setView] = useState({ year: 0, month: 0 });
  const rootRef = useRef<HTMLDivElement>(null);
  const dialogId = useId();

  const today = startOfDay(clock);
  const minDay = Math.max(
    min === undefined ? -Infinity : startOfDay(min),
    maxSpanMs === undefined ? -Infinity : startOfDay(clock - maxSpanMs),
  );
  const maxDay = Math.min(startOfDay(max ?? clock), today);

  // Opening lands on the month of the window in force, else this month.
  function toggle() {
    if (disabled) return;
    if (!open) {
      const now = Date.now();
      const d = new Date(value?.to ?? now);
      setClock(now);
      setView({ year: d.getFullYear(), month: d.getMonth() });
      setAnchor(null);
      setHover(null);
    }
    setOpen(!open);
  }

  useEffect(() => {
    if (!open) return;
    function onPointerDown(e: PointerEvent) {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setOpen(false);
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const cells = useMemo(() => monthGrid(view.year, view.month), [view]);
  const canPrev = minDay === -Infinity || new Date(view.year, view.month, 1).getTime() > minDay;
  const canNext = new Date(view.year, view.month + 1, 1).getTime() <= maxDay;

  function shift(delta: number) {
    setView((v) => {
      const d = new Date(v.year, v.month + delta, 1);
      return { year: d.getFullYear(), month: d.getMonth() };
    });
  }

  function pick(day: number) {
    if (anchor === null) {
      setAnchor(day);
      return;
    }
    onChange(dayRange(anchor, day, Date.now()));
    setAnchor(null);
    setHover(null);
    setOpen(false);
  }

  // The span to paint: the pick in progress (anchor to the hovered day),
  // else the window in force.
  const span = useMemo<{ lo: number; hi: number } | null>(() => {
    if (anchor !== null) {
      const other = hover ?? anchor;
      return anchor <= other ? { lo: anchor, hi: other } : { lo: other, hi: anchor };
    }
    if (value) return { lo: startOfDay(value.from), hi: startOfDay(value.to) };
    return null;
  }, [anchor, hover, value]);

  const active = value !== null;
  const label = active ? formatDateRange(value) : null;

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <div
        className={`inline-flex items-center rounded-full border transition-colors ${
          active
            ? "bg-elevated border-atnx-cyan/50 text-primary"
            : "bg-surface border-surface text-secondary"
        }`}
      >
        <button
          type="button"
          onClick={toggle}
          disabled={disabled}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-controls={open ? dialogId : undefined}
          aria-label={label ? `Chart dates: ${label}` : "Pick chart dates"}
          title={label ?? "Pick dates"}
          className={`h-8 inline-flex items-center gap-1.5 rounded-full text-xs font-bold whitespace-nowrap cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed link-quiet ${
            active ? "pl-2.5 pr-1 sm:pl-3 sm:pr-2" : "px-2.5"
          }`}
        >
          <CalendarIcon className={active ? "text-atnx-cyan light:text-atnx-cyan-light" : ""} />
          {/* The dates themselves need room the phone's tab row has not
              got; there the cyan icon and the clear button say a window
              is in force, and the title carries the dates. */}
          {label && (
            <span className="hidden sm:inline font-mono tabular-nums">{label}</span>
          )}
        </button>
        {active && (
          <button
            type="button"
            onClick={() => onChange(null)}
            aria-label="Clear chart dates"
            title="Clear"
            className="h-8 w-7 -ml-1 inline-flex items-center justify-center rounded-full text-tertiary link-quiet cursor-pointer"
          >
            <svg
              viewBox="0 0 24 24"
              width={12}
              height={12}
              fill="none"
              stroke="currentColor"
              strokeWidth={2.5}
              strokeLinecap="round"
              aria-hidden="true"
            >
              <path d="M6 6l12 12M18 6L6 18" />
            </svg>
          </button>
        )}
      </div>

      {open && (
        <div
          id={dialogId}
          role="dialog"
          aria-label="Pick chart dates"
          className={`absolute top-full mt-1.5 z-50 w-[280px] p-3 rounded-xl bg-elevated border border-surface shadow-xl ${
            align === "right" ? "right-0" : "left-0"
          }`}
        >
          <div className="flex items-center justify-between mb-2">
            <button
              type="button"
              onClick={() => shift(-1)}
              disabled={!canPrev}
              aria-label="Previous month"
              className="h-7 w-7 inline-flex items-center justify-center rounded-md text-secondary link-quiet hover-sink cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Chevron dir="left" />
            </button>
            <div className="text-xs font-bold text-primary" aria-live="polite">
              {monthTitle.format(new Date(view.year, view.month, 1))}
            </div>
            <button
              type="button"
              onClick={() => shift(1)}
              disabled={!canNext}
              aria-label="Next month"
              className="h-7 w-7 inline-flex items-center justify-center rounded-md text-secondary link-quiet hover-sink cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <Chevron dir="right" />
            </button>
          </div>

          <div
            className="grid grid-cols-7 gap-y-0.5"
            onPointerLeave={() => setHover(null)}
          >
            {WEEKDAYS.map((d) => (
              <div
                key={d}
                className="h-6 flex items-center justify-center text-[10px] font-mono uppercase tracking-wider text-tertiary"
                aria-hidden="true"
              >
                {d}
              </div>
            ))}
            {cells.map(({ t, inMonth }) => {
              const out = t < minDay || t > maxDay;
              const isEnd = span !== null && (t === span.lo || t === span.hi);
              const between = span !== null && t > span.lo && t < span.hi;
              const isToday = t === today;
              let cls: string;
              if (out) cls = "text-tertiary opacity-30 cursor-not-allowed";
              else if (isEnd) cls = "bg-atnx-cyan text-black font-bold";
              else if (between) cls = "bg-atnx-cyan/15 text-primary";
              else if (inMonth) cls = "text-primary hover-sink";
              else cls = "text-tertiary hover-sink";
              return (
                <button
                  key={t}
                  type="button"
                  disabled={out}
                  onClick={() => pick(t)}
                  onPointerEnter={() => setHover(t)}
                  onFocus={() => setHover(t)}
                  aria-label={dayLabel.format(new Date(t))}
                  aria-pressed={isEnd}
                  className={`h-8 text-xs font-mono tabular-nums cursor-pointer transition-colors ${
                    isEnd ? "rounded-md" : between ? "rounded-none" : "rounded-md"
                  } ${isToday && !isEnd ? "underline underline-offset-2 decoration-atnx-cyan/60" : ""} ${cls}`}
                >
                  {new Date(t).getDate()}
                </button>
              );
            })}
          </div>

          <div className="mt-2 text-[10px] text-tertiary font-mono text-center">
            {anchor === null
              ? "Tap a start day, then an end day"
              : `From ${shortDay.format(new Date(anchor))}, tap the end day`}
          </div>
        </div>
      )}
    </div>
  );
}
