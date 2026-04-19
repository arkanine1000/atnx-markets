"use client";

import { useEffect, useState } from "react";
import { timeAgo } from "@/lib/capture-view";
import type { TradeLogEvent } from "@/lib/store";

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

  useEffect(() => {
    let cancelled = false;

    async function fetchEvents() {
      try {
        const res = await fetch(`/api/markets/${marketId}/trades`);
        const data = await res.json();
        if (!cancelled && Array.isArray(data.events)) {
          setEvents(data.events);
        }
      } catch {
        // Silently retry on next poll
      }
    }

    const interval = setInterval(fetchEvents, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [marketId]);

  return (
    <div className="pt-4 border-t border-surface">
      <div className="text-[11px] uppercase tracking-wider text-tertiary mb-2">
        Trade log ({events.length})
      </div>
      {events.length === 0 ? (
        <div className="text-xs text-secondary py-2">
          No trades yet. Be the first.
        </div>
      ) : (
        <div className="max-h-72 overflow-y-auto">
          <ul className="space-y-1">
            {events.map((e) => {
              const isLong = e.direction === "long";
              const isClose = e.kind === "close";
              const actionLabel = isClose
                ? "CLOSE"
                : isLong
                ? "BUY"
                : "SELL";
              const actionColor = isClose
                ? "text-secondary"
                : isLong
                ? "text-atnx-cyan"
                : "text-atnx-magenta";
              const pnlColor =
                e.pnl === null
                  ? ""
                  : e.pnl >= 0
                  ? "text-atnx-cyan"
                  : "text-atnx-magenta";

              return (
                <li
                  key={e.id}
                  className="flex items-center gap-2 text-xs font-mono tabular-nums py-1 border-b border-surface/50 last:border-b-0"
                >
                  <span className={`${actionColor} font-bold w-12 shrink-0`}>
                    {actionLabel}
                  </span>
                  <span className="text-primary truncate min-w-0 flex-1">
                    @{e.handle}
                  </span>
                  <span className="text-tertiary shrink-0">
                    {formatUsd(e.sizeUsd)}
                    <span className="text-secondary">×{e.leverage}</span>
                  </span>
                  <span className="text-atnx-yellow shrink-0 w-12 text-right">
                    {e.vi}
                  </span>
                  {e.pnl !== null ? (
                    <span className={`${pnlColor} shrink-0 w-16 text-right`}>
                      {formatPnl(e.pnl)}
                    </span>
                  ) : (
                    <span className="shrink-0 w-16" />
                  )}
                  <span className="text-tertiary shrink-0 w-16 text-right">
                    {timeAgo(e.at)}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </div>
  );
}
