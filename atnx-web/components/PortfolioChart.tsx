"use client";

import { PortfolioSparkline } from "@/components/charts/PortfolioSparkline";
import { Card } from "@/components/ui";
import { RANGES, RangeTabs, type PortfolioFeed } from "@/components/usePortfolioFeed";

// The desktop portfolio chart: value over the picked window, with the
// window's change and the range switch in the header. It sits beside the
// stat tiles and stretches to their height. The value itself is the Equity
// tile next to it, so it isn't repeated here.

const usd = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", maximumFractionDigits: 2 });

function signed(n: number, fmt: (x: number) => string) {
  return `${n >= 0 ? "+" : "-"}${fmt(Math.abs(n))}`;
}

export function PortfolioChart({ feed, className = "" }: { feed: PortfolioFeed; className?: string }) {
  const { range, pickRange, data, error, busy } = feed;
  const shown = RANGES[data && RANGES[data.range] ? data.range : range];
  const up = (data?.changeUsd ?? 0) >= 0;
  const tone = up ? "text-atnx-cyan light:text-atnx-cyan-light" : "text-atnx-magenta light:text-atnx-magenta-light";
  const history = data?.history ?? [];
  const first = history[0];

  return (
    <Card className={`p-4 sm:p-5 min-w-0 flex flex-col ${busy && data ? "opacity-90" : ""} transition-opacity ${className}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-[10px] sm:text-[11px] font-mono uppercase tracking-[0.15em] text-tertiary mb-1.5">
            Portfolio value
          </div>
          {data ? (
            <div className={`text-xs font-bold font-mono tabular-nums whitespace-nowrap ${tone}`}>
              {signed(data.changeUsd, (x) => usd.format(x))} ({signed(data.changePercent, (x) => x.toFixed(1))}%){" "}
              <span className="text-tertiary font-normal">{shown.delta}</span>
            </div>
          ) : (
            <div className="text-xs text-tertiary">{error ?? "Loading…"}</div>
          )}
        </div>
        <RangeTabs range={range} onPick={pickRange} className="shrink-0" />
      </div>

      <div className="flex-1 min-h-[160px] mt-3">
        <PortfolioSparkline points={history} height="fill" formatTime={(t) => shown.time.format(t)} />
      </div>

      {history.length >= 2 && first && (
        <div className="mt-2 flex justify-between text-[10px] font-mono text-tertiary tabular-nums">
          <span>{shown.time.format(new Date(first.t))}</span>
          <span>Now</span>
        </div>
      )}
    </Card>
  );
}
