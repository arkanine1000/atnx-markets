"use client";

import type { HTMLAttributes, ReactNode } from "react";
import { viTier } from "@/lib/vi/score";

// Small presentational primitives shared across the /app section.
// Brand rule of thumb: cyan = up / long, magenta = down / short, yellow = the
// Virality Index itself.

interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  disabled?: boolean;
  title?: string;
}

interface SegmentedProps<T extends string> {
  /** null selects nothing, e.g. when a control beside the tabs is in force. */
  value: T | null;
  onChange: (v: T) => void;
  options: SegmentedOption<T>[];
  /** "accent" paints the active pill magenta; "neutral" lifts it to the elevated surface. */
  tone?: "accent" | "neutral";
  size?: "sm" | "md";
  className?: string;
  /** Classes for every option, e.g. a fixed width so the pills line up. */
  itemClassName?: string;
  ariaLabel?: string;
}

export function Segmented<T extends string>({
  value,
  onChange,
  options,
  tone = "neutral",
  size = "sm",
  className = "",
  itemClassName = "",
  ariaLabel,
}: SegmentedProps<T>) {
  const pad = size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm";
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`inline-flex items-center gap-0.5 p-1 rounded-full bg-surface border border-surface ${className}`}
    >
      {options.map((o) => {
        const active = o.value === value;
        const activeCls =
          tone === "accent"
            ? "bg-atnx-magenta text-white shadow-[0_0_16px_rgba(255,0,229,0.25)]"
            : "bg-elevated text-primary shadow-sm";
        return (
          <button
            key={o.value}
            role="tab"
            type="button"
            aria-selected={active}
            disabled={o.disabled}
            title={o.title}
            onClick={() => onChange(o.value)}
            className={`${pad} ${itemClassName} inline-flex items-center justify-center rounded-full font-bold whitespace-nowrap transition-colors cursor-pointer disabled:opacity-35 disabled:cursor-not-allowed ${
              active ? activeCls : "text-secondary link-quiet"
            }`}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

/** Signed percentage with a direction glyph. Cyan up, magenta down. A null
 *  value (no baseline to measure against) is a neutral dash. */
export function DeltaChip({
  value,
  suffix = "",
  size = "sm",
  className = "",
}: {
  value: number | null;
  suffix?: string;
  size?: "sm" | "md";
  className?: string;
}) {
  // A ticker readout, not a pill: colour and weight do the work.
  const sz = size === "sm" ? "text-xs" : "text-sm";
  if (value === null) {
    return (
      <span
        className={`inline-flex items-center font-mono font-bold tabular-nums whitespace-nowrap text-tertiary ${sz} ${className}`}
        title="Not enough history yet"
      >
        —{suffix}
      </span>
    );
  }
  const up = value >= 0;
  const tone = up
    ? "text-atnx-cyan light:text-atnx-cyan-light"
    : "text-atnx-magenta light:text-atnx-magenta-light";
  return (
    <span
      className={`inline-flex items-center gap-1 font-mono font-bold tabular-nums whitespace-nowrap ${sz} ${tone} ${className}`}
    >
      <span aria-hidden="true" className="text-[0.8em]">{up ? "▲" : "▼"}</span>
      {up ? "+" : "-"}
      {Math.abs(value).toFixed(1)}%{suffix}
    </span>
  );
}

/** The Virality Index number, always yellow; "Scoring…" for a new market
 *  whose first pass over every source has not finished (supabase/018). */
export function ScoreBadge({
  value,
  size = "sm",
  className = "",
  scoring = false,
}: {
  value: number;
  size?: "sm" | "md" | "lg";
  className?: string;
  scoring?: boolean;
}) {
  if (scoring) {
    return (
      <span
        className={`inline-flex items-center justify-end leading-none text-tertiary font-mono text-[11px] uppercase tracking-wider animate-pulse ${className}`}
        title="Reading every source for this new market"
      >
        Scoring…
      </span>
    );
  }
  // Bare number in the display face; yellow is the VI's colour everywhere.
  const sz =
    size === "lg" ? "text-3xl" : size === "md" ? "text-2xl" : "text-lg";
  return (
    <span
      className={`inline-flex items-center justify-end leading-none text-atnx-yellow light:text-atnx-yellow-light font-display font-bold tabular-nums ${sz} ${className}`}
      title={`Virality Index · ${viTier(value).label}`}
    >
      {value}
    </span>
  );
}

export function Chip({
  children,
  tone = "neutral",
  className = "",
}: {
  children: ReactNode;
  tone?: "neutral" | "cyan" | "magenta" | "yellow";
  className?: string;
}) {
  const tones = {
    neutral: "bg-elevated text-secondary border-surface",
    cyan: "bg-atnx-cyan/10 text-atnx-cyan light:text-atnx-cyan-light border-atnx-cyan/25",
    magenta:
      "bg-atnx-magenta/10 text-atnx-magenta light:text-atnx-magenta-light border-atnx-magenta/25",
    yellow:
      "bg-atnx-yellow/10 text-atnx-yellow light:text-atnx-yellow-light border-atnx-yellow/25",
  };
  return (
    <span
      className={`inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10px] font-bold font-mono uppercase tracking-wider whitespace-nowrap ${tones[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

export function Card({
  children,
  className = "",
  ...rest
}: {
  children: ReactNode;
  className?: string;
} & Omit<HTMLAttributes<HTMLDivElement>, "className" | "children">) {
  return (
    <div
      className={`bg-surface border border-surface rounded-2xl ${className}`}
      {...rest}
    >
      {children}
    </div>
  );
}

/** Label-over-value tile. `hero` bumps the value to display size. */
export function StatTile({
  label,
  value,
  sub,
  hero = false,
  className = "",
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  hero?: boolean;
  className?: string;
}) {
  return (
    <Card className={`p-4 sm:p-5 min-w-0 ${className}`}>
      <div className="text-[10px] sm:text-[11px] font-mono uppercase tracking-[0.15em] text-tertiary mb-1.5">
        {label}
      </div>
      <div
        className={`font-display font-bold tabular-nums text-primary truncate ${
          hero ? "text-2xl sm:text-3xl" : "text-xl sm:text-2xl"
        }`}
      >
        {value}
      </div>
      {sub && (
        <div className="mt-1.5 text-xs text-tertiary flex items-center gap-2">
          {sub}
        </div>
      )}
    </Card>
  );
}

/** Label-over-value pair with no container. Lay several out in a grid and
 *  let a hairline above the row do the separating. */
export function Readout({
  label,
  value,
  className = "",
  valueClassName = "",
}: {
  label: ReactNode;
  value: ReactNode;
  className?: string;
  valueClassName?: string;
}) {
  return (
    <div className={`min-w-0 ${className}`}>
      <div className="text-[10px] font-mono uppercase tracking-wider text-tertiary">
        {label}
      </div>
      <div className={`mt-0.5 text-sm font-mono tabular-nums truncate ${valueClassName}`}>
        {value}
      </div>
    </div>
  );
}

export function EmptyState({
  title,
  body,
  action,
}: {
  title: string;
  body?: ReactNode;
  action?: ReactNode;
}) {
  return (
    <Card className="p-10 sm:p-14 text-center">
      <div className="mx-auto mb-4 h-12 w-12 rounded-2xl bg-elevated border border-surface flex items-center justify-center text-tertiary text-xl">
        {"⌘"}
      </div>
      <p className="text-primary text-sm font-bold">{title}</p>
      {body && (
        <p className="text-tertiary text-xs mt-2 max-w-sm mx-auto leading-relaxed">
          {body}
        </p>
      )}
      {action && <div className="mt-5">{action}</div>}
    </Card>
  );
}

/** Dollars for a label: $980, $2.4k, $12k, $1.2M. */
export function compactUsd(n: number): string {
  const abs = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (abs >= 1_000_000) return `${sign}$${(abs / 1_000_000).toFixed(abs >= 10_000_000 ? 0 : 1)}M`;
  if (abs >= 1000) return `${sign}$${(abs / 1000).toFixed(abs >= 10_000 ? 0 : 1)}k`;
  return `${sign}$${Math.round(abs)}`;
}

export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url || "—";
  }
}
