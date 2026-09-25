"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { PortfolioRange, PortfolioResponse } from "@/app/api/portfolio/route";

// One /api/portfolio feed for the portfolio page: the range picked, the
// latest snapshot for it, and a 30 s refresh while the tab is visible. The
// page holds a single instance and hands it to both the phone layout and the
// desktop chart, so the two share a range and never poll twice.

const REFRESH_MS = 30_000;
const RANGE_KEY = "atnx:portfolio:range";

export const RANGES: Record<PortfolioRange, { label: string; delta: string; time: Intl.DateTimeFormat }> = {
  "1d": {
    label: "1D",
    delta: "24h",
    time: new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "2-digit" }),
  },
  "1w": {
    label: "1W",
    delta: "7d",
    time: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
  },
  "1m": {
    label: "1M",
    delta: "30d",
    time: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }),
  },
  all: {
    label: "ALL",
    delta: "all time",
    time: new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }),
  },
};
export const RANGE_ORDER: PortfolioRange[] = ["1d", "1w", "1m", "all"];

export function readStored<T extends string>(key: string, ok: (v: string) => v is T, fallback: T): T {
  try {
    const v = window.localStorage.getItem(key);
    return v !== null && ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
export function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}

export interface PortfolioFeed {
  range: PortfolioRange;
  pickRange: (r: PortfolioRange) => void;
  data: PortfolioResponse | null;
  error: string | null;
  busy: boolean;
  // Drops cached windows and refetches the current one.
  refresh: () => Promise<void>;
}

export function usePortfolioFeed(refreshKey?: string): PortfolioFeed {
  const [range, setRange] = useState<PortfolioRange>("1w");
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cache = useRef(new Map<PortfolioRange, PortfolioResponse>());
  const inflight = useRef(0);

  // The saved range applies after hydration (the server render uses the
  // default, so the first client render must match it).
  useEffect(() => {
    setRange(readStored(RANGE_KEY, (v): v is PortfolioRange => v in RANGES, "1w"));
  }, []);

  const load = useCallback(async (r: PortfolioRange) => {
    const id = ++inflight.current;
    setBusy(true);
    try {
      const res = await fetch(`/api/portfolio?range=${r}`, { credentials: "same-origin" });
      if (!res.ok) throw new Error(res.status === 401 ? "Sign in to see your portfolio" : `Portfolio unavailable (${res.status})`);
      const body = (await res.json()) as PortfolioResponse;
      cache.current.set(r, body);
      // A newer request (range switch) will draw its own answer.
      if (id !== inflight.current) return;
      setData(body);
      setError(null);
    } catch (err) {
      if (id !== inflight.current) return;
      setError((err as Error).message);
    } finally {
      if (id === inflight.current) setBusy(false);
    }
  }, []);

  // Fetch on mount, on range change, on an external change, and every 30 s
  // while the tab is visible.
  useEffect(() => {
    const cached = cache.current.get(range);
    if (cached) setData(cached);
    load(range);
    let timer: ReturnType<typeof setInterval> | null = null;
    const start = () => {
      if (timer) return;
      timer = setInterval(() => load(range), REFRESH_MS);
    };
    const stop = () => {
      if (timer) clearInterval(timer);
      timer = null;
    };
    const onVis = () => {
      if (document.visibilityState === "visible") {
        load(range);
        start();
      } else stop();
    };
    if (document.visibilityState === "visible") start();
    document.addEventListener("visibilitychange", onVis);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [range, load, refreshKey]);

  const pickRange = useCallback((r: PortfolioRange) => {
    setRange(r);
    writeStored(RANGE_KEY, r);
  }, []);

  const refresh = useCallback(async () => {
    cache.current.clear();
    await load(range);
  }, [load, range]);

  return { range, pickRange, data, error, busy, refresh };
}

// The 1D / 1W / 1M / ALL switch. `stretch` spreads the buttons across the
// row (the phone tile); otherwise they sit compact (the desktop chart).
export function RangeTabs({
  range,
  onPick,
  stretch = false,
  className = "",
}: {
  range: PortfolioRange;
  onPick: (r: PortfolioRange) => void;
  stretch?: boolean;
  className?: string;
}) {
  return (
    <div role="group" aria-label="Chart range" className={`flex gap-1 ${className}`}>
      {RANGE_ORDER.map((r) => {
        const active = r === range;
        return (
          <button
            key={r}
            type="button"
            aria-pressed={active}
            onClick={() => {
              if (!active) onPick(r);
            }}
            className={`${stretch ? "flex-1" : "px-2.5"} py-1.5 rounded-md text-[10px] font-bold tracking-[0.1em] border transition-colors cursor-pointer ${
              active
                ? "bg-elevated border-surface text-primary"
                : "border-transparent text-tertiary hover:text-primary hover:bg-elevated"
            }`}
          >
            {RANGES[r].label}
          </button>
        );
      })}
    </div>
  );
}
