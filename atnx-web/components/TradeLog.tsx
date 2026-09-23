"use client";

import { useEffect, useState } from "react";
import { timeAgo } from "@/lib/capture-view";
import { startPolling } from "@/lib/poll";
import type { TradeLogEvent } from "@/lib/store";

const POLL_MS = 30_000;

interface Props {
  marketId: string;
  initialEvents: TradeLogEvent[];
}

function formatUsd(n: number): string {
  if (n >= 1000) return `$${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k`;
  return `$${Math.round(n)}`;
}

function formatPnl(pnl: number): string {
  const sign = pnl >= 0 ? "+" : "-";
  return `${sign}${formatUsd(Math.abs(pnl))}`;
}

export function TradeLog({ marketId, initialEvents }: Props) {
  const [events, setEvents] = useState<TradeLogEvent[]>(initialEvents);

  // The page arrives with the log in it; poll from a full interval on,
  // only while visible, backing off while the API is failing.
  useEffect(() => {
    async function fetchEvents() {
      const res = await fetch(`/api/markets/${marketId}/trades`);
      if (!res.ok) throw new Error(`trades ${res.status}`);
      const data = await res.json();
      if (Array.isArray(data.events)) setEvents(data.events);
    }
    return startPolling(fetchEvents, { intervalMs: POLL_MS });
  }, [marketId]);

  if (events.length === 0) {
    return (
      <div className="py-8 text-center">
        <p className="text-sm text-secondary">No trades yet.</p>
        <p className="text-xs text-tertiary mt-1">
          Be the first to take a side.
        </p>
      </div>
    );
  }

  return (
    <div className="max-h-96 overflow-y-auto -mx-1 px-1">
      <div className="flex items-center gap-3 px-2 pb-2 text-[10px] font-mono uppercase tracking-wider text-tertiary">
        <span className="w-12">Side</span>
        <span className="flex-1">Trader</span>
        <span className="w-16 text-right">Size</span>
        <span className="w-12 text-right">VI</span>
        <span className="w-16 text-right">PnL</span>
        <span className="w-14 text-right">When</span>
      </div>
      <ul className="space-y-1">
        {events.map((e) => {
          const isLong = e.direction === "long";
          const isClose = e.kind === "close";
          const label = isClose ? "Close" : isLong ? "Long" : "Short";
          const tone = isClose
            ? "bg-elevated text-secondary border-surface"
            : isLong
              ? "bg-atnx-cyan/10 text-atnx-cyan light:text-atnx-cyan-light border-atnx-cyan/25"
              : "bg-atnx-magenta/10 text-atnx-magenta light:text-atnx-magenta-light border-atnx-magenta/25";
          const pnlColor =
            e.pnl === null
              ? ""
              : e.pnl >= 0
                ? "text-atnx-cyan light:text-atnx-cyan-light"
                : "text-atnx-magenta light:text-atnx-magenta-light";

          return (
            <li
              key={e.id}
              className="flex items-center gap-3 px-2 py-2 rounded-lg text-xs font-mono tabular-nums hover:bg-elevated transition-colors"
            >
              <span
                className={`w-12 shrink-0 inline-flex justify-center rounded-md border px-1.5 py-0.5 text-[10px] font-bold font-mono uppercase tracking-wider ${tone}`}
              >
                {label}
              </span>
              <span className="text-primary truncate min-w-0 flex-1">
                @{e.handle}
              </span>
              <span className="w-16 text-right text-secondary shrink-0">
                {formatUsd(e.sizeUsd)}
                <span className="text-tertiary">
                  {"×"}
                  {e.leverage}
                </span>
              </span>
              <span className="w-12 text-right text-atnx-yellow light:text-atnx-yellow-light shrink-0">
                {e.vi}
              </span>
              <span
                className={`w-16 text-right shrink-0 font-bold ${pnlColor}`}
              >
                {e.pnl !== null ? formatPnl(e.pnl) : "—"}
              </span>
              <span className="w-14 text-right text-tertiary shrink-0">
                {timeAgo(e.at)}
              </span>
            </li>
          );
        })}
      </ul>
    </div>
  );
}
