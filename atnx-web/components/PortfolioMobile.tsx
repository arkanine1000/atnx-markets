"use client";

import Link from "next/link";
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  PortfolioPosition,
  PortfolioRange,
  PortfolioResponse,
} from "@/app/api/portfolio/route";
import { PortfolioSparkline } from "@/components/charts/PortfolioSparkline";
import { Card } from "@/components/ui";
import { timeAgo } from "@/lib/capture-view";

// The portfolio the way the extension's side panel shows it, for phones:
// one value tile (hero number, range delta, sparkline, range tabs), then a
// collapsible card with the three numbers that expands into position rows.
// Reads /api/portfolio, the same endpoint the extension uses, so the two
// always agree.

const REFRESH_MS = 30_000;

const RANGES: Record<PortfolioRange, { label: string; delta: string; time: Intl.DateTimeFormat }> = {
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
const RANGE_ORDER: PortfolioRange[] = ["1d", "1w", "1m", "all"];
const RANGE_KEY = "atnx:portfolio:range";
const OPEN_KEY = "atnx:portfolio:open";

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });
const usdCompact = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 0 });

function signed(n: number, fmt: (x: number) => string) {
  return `${n >= 0 ? "+" : "-"}${fmt(Math.abs(n))}`;
}

function readStored<T extends string>(key: string, ok: (v: string) => v is T, fallback: T): T {
  try {
    const v = window.localStorage.getItem(key);
    return v !== null && ok(v) ? v : fallback;
  } catch {
    return fallback;
  }
}
function writeStored(key: string, value: string) {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    /* private mode etc. */
  }
}

const UP = "text-atnx-cyan light:text-atnx-cyan-light";
const DOWN = "text-atnx-magenta light:text-atnx-magenta-light";

function Thumb({ src, name, short }: { src: string | null; name: string; short: boolean }) {
  const [broken, setBroken] = useState(false);
  return (
    <div className="relative h-10 w-10 shrink-0 rounded-[9px] overflow-hidden border border-surface bg-elevated grid place-items-center text-secondary font-bold text-sm">
      {src && !broken ? (
        // eslint-disable-next-line @next/next/no-img-element
        <img src={src} alt="" loading="lazy" onError={() => setBroken(true)} className="h-full w-full object-cover" />
      ) : (
        <span>{(name || "?").trim().charAt(0).toUpperCase()}</span>
      )}
      {short && (
        <span
          title="Short"
          className="absolute -right-px -bottom-px rounded-tl-[5px] rounded-br-[6px] bg-atnx-magenta px-1 py-0.5 text-[9px] font-bold leading-none text-black"
        >
          S
        </span>
      )}
    </div>
  );
}

function PositionRow({
  p,
  open,
  onToggle,
  onClose,
  closing,
}: {
  p: PortfolioPosition;
  open: boolean;
  onToggle: () => void;
  onClose: () => void;
  closing: boolean;
}) {
  const up = p.pnlPercent >= 0;
  return (
    <li className="border-t border-surface">
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="w-full grid grid-cols-[auto_1fr_auto] items-center gap-3 px-3.5 py-2.5 text-left cursor-pointer active:bg-elevated transition-colors"
      >
        <Thumb src={p.imageUrl} name={p.name} short={p.direction === "short"} />
        <span className="min-w-0">
          <span className="block font-bold text-sm text-primary truncate">{p.name}</span>
          <span className="block text-[11px] text-tertiary truncate">
            {p.direction === "short" ? "Short" : "Long"} {p.leverage}× · {usd.format(p.sizeUsd)} in
          </span>
        </span>
        <span className="text-right whitespace-nowrap">
          <span className="block font-bold text-sm text-primary font-mono tabular-nums">{usd.format(p.valueUsd)}</span>
          <span className={`block text-[11px] font-mono tabular-nums ${up ? UP : DOWN}`}>
            {signed(p.pnlPercent, (x) => x.toFixed(1))}%
          </span>
        </span>
      </button>
      {open && (
        <div className="px-3.5 pb-3.5">
          <dl className="grid grid-cols-4 gap-1.5 text-xs">
            {[
              ["Entry", String(p.entryVi), "text-atnx-yellow light:text-atnx-yellow-light"],
              ["Now", String(p.currentVi), "text-atnx-yellow light:text-atnx-yellow-light"],
              ["PnL", signed(p.pnlUsd, (x) => usd.format(x)), up ? UP : DOWN],
              ["Opened", timeAgo(p.openedAt), "text-primary"],
            ].map(([k, v, cls]) => (
              <div key={k} className="rounded-lg bg-elevated px-2 py-1.5 min-w-0">
                <dt className="text-[9px] uppercase tracking-wider text-tertiary">{k}</dt>
                <dd className={`mt-0.5 text-[12px] font-mono tabular-nums truncate ${cls}`}>{v}</dd>
              </div>
            ))}
          </dl>
          <div className="mt-2.5 flex items-center justify-between">
            <Link
              href={`/app/markets/${p.marketId}`}
              className="text-[11px] text-secondary hover:text-atnx-cyan transition-colors"
            >
              View market {"↗"}
            </Link>
            <button
              type="button"
              disabled={closing}
              onClick={onClose}
              className="text-[11px] px-3 py-1.5 rounded-full border border-surface text-secondary hover:border-atnx-magenta/50 hover:text-atnx-magenta cursor-pointer transition-colors disabled:opacity-50"
            >
              {closing ? "Closing…" : "Close position"}
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function PortfolioMobile({
  onClosePosition,
  refreshKey,
}: {
  // Closes the position and resolves once the server has done so; the
  // caller shows its own confirmation. The list refetches afterwards.
  onClosePosition: (id: string) => Promise<void>;
  // Any change here (a trade elsewhere on the page) triggers a refetch.
  refreshKey?: string;
}) {
  const [range, setRange] = useState<PortfolioRange>("1w");
  // Positions are what the page is for: open by default, collapsed only
  // when the person has folded it.
  const [open, setOpen] = useState(true);
  const [data, setData] = useState<PortfolioResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [closingId, setClosingId] = useState<string | null>(null);
  const cache = useRef(new Map<PortfolioRange, PortfolioResponse>());
  const inflight = useRef(0);

  // Saved preferences apply after hydration (the server render uses the
  // defaults, so the first client render must match it).
  useEffect(() => {
    setRange(readStored(RANGE_KEY, (v): v is PortfolioRange => v in RANGES, "1w"));
    setOpen(readStored(OPEN_KEY, (v): v is "1" | "0" => v === "1" || v === "0", "1") === "1");
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

  function pickRange(r: PortfolioRange) {
    if (r === range) return;
    setRange(r);
    writeStored(RANGE_KEY, r);
  }
  function toggleOpen() {
    setOpen((v) => {
      writeStored(OPEN_KEY, v ? "0" : "1");
      return !v;
    });
  }

  async function close(id: string) {
    setClosingId(id);
    try {
      await onClosePosition(id);
      cache.current.clear();
      await load(range);
    } finally {
      setClosingId(null);
      setExpanded(null);
    }
  }

  const delta = data ? RANGES[RANGES[data.range] ? data.range : range] : RANGES[range];
  const up = (data?.changeUsd ?? 0) >= 0;

  return (
    <div className={`space-y-5 ${busy && data ? "opacity-80" : ""} transition-opacity`}>
      {/* Value tile */}
      <Card className="px-4 pt-4 pb-3">
        <div className="flex items-baseline justify-between gap-2">
          <span className="text-[10px] uppercase tracking-[0.15em] text-tertiary">Portfolio value</span>
          {data && (
            <span className={`text-xs font-bold whitespace-nowrap font-mono tabular-nums ${up ? UP : DOWN}`}>
              {signed(data.changeUsd, (x) => usdCompact.format(x))} ({signed(data.changePercent, (x) => x.toFixed(1))}%){" "}
              {delta.delta}
            </span>
          )}
        </div>
        <div className="mt-0.5 mb-2 text-3xl font-bold tracking-tight text-primary font-mono tabular-nums">
          {data ? usd.format(data.totalValueUsd) : error ? "—" : "…"}
        </div>
        <PortfolioSparkline
          points={data?.history ?? []}
          height={72}
          formatTime={(t) => delta.time.format(t)}
        />
        <div role="group" aria-label="Chart range" className="mt-2 flex gap-1">
          {RANGE_ORDER.map((r) => {
            const active = r === range;
            return (
              <button
                key={r}
                type="button"
                aria-pressed={active}
                onClick={() => pickRange(r)}
                className={`flex-1 py-1.5 rounded-md text-[10px] font-bold tracking-[0.1em] border transition-colors cursor-pointer ${
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
      </Card>

      {/* Positions */}
      <section>
        <div className="flex items-center justify-between mb-2">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.15em] text-tertiary">Portfolio</h3>
          <button
            type="button"
            onClick={() => load(range)}
            aria-label="Refresh"
            title="Refresh"
            className="h-7 w-7 inline-flex items-center justify-center rounded-md text-tertiary hover:text-primary hover:bg-elevated cursor-pointer transition-colors"
          >
            <svg
              viewBox="0 0 24 24"
              width={15}
              height={15}
              aria-hidden="true"
              className={busy ? "animate-spin" : ""}
              style={busy ? { animationDuration: "0.8s" } : undefined}
            >
              <path
                fill="none"
                stroke="currentColor"
                strokeWidth={2.2}
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5"
              />
            </svg>
          </button>
        </div>
        <Card className="overflow-hidden">
          {error && !data ? (
            <div className="px-4 py-5 text-center text-xs text-tertiary">{error}</div>
          ) : !data ? (
            <div className="px-4 py-5 text-center text-xs text-tertiary">Loading…</div>
          ) : (
            <>
              <button
                type="button"
                onClick={toggleOpen}
                aria-expanded={open}
                aria-controls="portfolio-positions"
                className="w-full grid grid-cols-[1fr_1fr_auto_20px] items-center gap-2.5 px-3.5 py-3 text-left cursor-pointer active:bg-elevated transition-colors"
              >
                <span className="min-w-0">
                  <span className="block text-[10px] uppercase tracking-wider text-tertiary mb-0.5">Balance</span>
                  <span className="block text-[15px] font-bold font-mono tabular-nums truncate text-atnx-yellow light:text-atnx-yellow-light">
                    {usd.format(data.balanceUsd)}
                  </span>
                </span>
                <span className="min-w-0">
                  <span className="block text-[10px] uppercase tracking-wider text-tertiary mb-0.5">Unrealized</span>
                  <span
                    className={`block text-[15px] font-bold font-mono tabular-nums truncate ${
                      data.unrealizedPnlUsd >= 0 ? UP : DOWN
                    }`}
                  >
                    {signed(data.unrealizedPnlUsd, (x) => usd.format(x))}
                  </span>
                </span>
                <span className="min-w-0 text-right">
                  <span className="block text-[10px] uppercase tracking-wider text-tertiary mb-0.5">Open</span>
                  <span className="block text-[15px] font-bold font-mono tabular-nums text-primary">
                    {data.positions.length}
                  </span>
                </span>
                <svg
                  viewBox="0 0 24 24"
                  width={16}
                  height={16}
                  aria-hidden="true"
                  className={`text-tertiary transition-transform ${open ? "rotate-180" : ""}`}
                >
                  <path
                    d="M6 9l6 6 6-6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth={2.2}
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  />
                </svg>
              </button>
              {open && (
                <ul id="portfolio-positions">
                  {data.positions.length === 0 ? (
                    <li className="border-t border-surface px-4 py-5 text-center text-xs text-tertiary">
                      No open positions.
                      <Link href="/app" className="block mt-2 text-atnx-cyan">
                        Browse markets {"→"}
                      </Link>
                    </li>
                  ) : (
                    data.positions.map((p) => (
                      <PositionRow
                        key={p.id}
                        p={p}
                        open={expanded === p.id}
                        onToggle={() => setExpanded((cur) => (cur === p.id ? null : p.id))}
                        onClose={() => close(p.id)}
                        closing={closingId === p.id}
                      />
                    ))
                  )}
                </ul>
              )}
            </>
          )}
        </Card>
        {data && (
          <p className="mt-2 text-[10px] text-tertiary text-center">
            Realized {signed(data.realizedPnlUsd, (x) => usd.format(x))} over {data.totalTrades}{" "}
            {data.totalTrades === 1 ? "trade" : "trades"}
          </p>
        )}
      </section>
    </div>
  );
}
