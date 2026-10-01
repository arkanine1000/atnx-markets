"use client";

import { useMemo, useState } from "react";
import { Segmented } from "@/components/ui";
import { impliedDepth, type Level } from "@/lib/bm/depth";
import type { Side } from "@/lib/bm/fpmm";
import type { BmMarketRow } from "@/lib/supabase/database-bm";
import { fmtCents } from "./format";
import { liveRow, useBmChain, useOnchainMarket } from "./useBounded";

// The book the pool implies, laid out the way prediction-market books
// are: asks above the mid (what it costs to buy more), bids below (what
// selling fetches), nearest levels at the middle, cumulative depth
// shaded behind each row, one outcome at a time.
export function OrderBook({ bounded }: { bounded: BmMarketRow[] }) {
  const { chain } = useBmChain();
  const row = liveRow(bounded, chain.key);
  const oc = useOnchainMarket(chain, row);
  const [side, setSide] = useState<Side>("up");

  const depth = useMemo(() => (oc.pools ? impliedDepth(oc.pools, side, oc.feeBps, 0.01, 12) : null), [oc.pools, oc.feeBps, side]);

  if (!row) return <p className="text-xs text-tertiary">No UP/DOWN market is open on {chain.label}.</p>;
  if (!depth) return <p className="text-xs text-tertiary animate-pulse">Reading the pool…</p>;

  const maxTotal = Math.max(1, ...depth.asks.map((l) => l.total), ...depth.bids.map((l) => l.total));
  const asksTopDown = [...depth.asks].reverse();
  const feePct = Number(oc.feeBps) / 100;
  const poolUsdg = oc.market ? Number(oc.market.collateral) / 1e6 : 0;

  return (
    <div>
      <div className="flex items-center justify-between gap-3 mb-3 flex-wrap">
        <Segmented
          ariaLabel="Outcome"
          value={side}
          onChange={(v) => setSide(v as Side)}
          options={[
            { value: "up", label: "UP" },
            { value: "down", label: "DOWN" },
          ]}
        />
        <div className="text-[11px] text-tertiary">
          Liquidity <span className="text-primary font-mono tabular-nums">{poolUsdg.toLocaleString(undefined, { maximumFractionDigits: 0 })} USDG</span>
          <span className="mx-2">·</span>
          Fee <span className="text-primary font-mono tabular-nums">{feePct}%</span>
        </div>
      </div>

      <div className="rounded-xl border border-surface overflow-hidden">
        <div className="grid grid-cols-[1fr_1.2fr_1.2fr] px-3 py-1.5 text-[10px] font-mono uppercase tracking-wider text-tertiary border-b border-surface bg-elevated/40">
          <span>Price</span>
          <span className="text-right">Shares</span>
          <span className="text-right">Total (USDG)</span>
        </div>

        <ul aria-label="Asks">
          {asksTopDown.map((l) => (
            <Row key={`a${l.price}`} level={l} tone="ask" maxTotal={maxTotal} />
          ))}
        </ul>

        <div className="flex items-center justify-between px-3 py-2 bg-elevated border-y border-surface text-xs">
          <span className="text-tertiary">
            Mid <span className="text-primary font-bold font-mono tabular-nums">{fmtCents(depth.mid)}</span>
          </span>
          <span className="text-[11px] text-tertiary">
            Spread <span className="font-mono tabular-nums text-primary">0¢</span> · the pool quotes both sides
          </span>
        </div>

        <ul aria-label="Bids">
          {depth.bids.map((l) => (
            <Row key={`b${l.price}`} level={l} tone="bid" maxTotal={maxTotal} />
          ))}
        </ul>
      </div>

      <p className="text-[11px] text-tertiary mt-2 leading-relaxed">
        Each row is what the pool will trade before the price moves past that level: asks are {side.toUpperCase()} shares for sale as the price climbs,
        bids what it pays as the price falls. Totals are cumulative from the mid, fee included.
      </p>
    </div>
  );
}

function Row({ level, tone, maxTotal }: { level: Level; tone: "ask" | "bid"; maxTotal: number }) {
  const width = `${Math.min(100, (level.total / maxTotal) * 100).toFixed(1)}%`;
  const color = tone === "ask" ? "rgba(255,0,229,0.14)" : "rgba(0,212,255,0.14)";
  const priceTone = tone === "ask" ? "text-atnx-magenta light:text-atnx-magenta-light" : "text-atnx-cyan light:text-atnx-cyan-light";
  return (
    <li className="relative grid grid-cols-[1fr_1.2fr_1.2fr] px-3 py-1 text-xs font-mono tabular-nums">
      <span className="absolute inset-y-0 right-0" style={{ width, background: color }} aria-hidden="true" />
      <span className={`relative font-bold ${priceTone}`}>{fmtCents(level.price)}</span>
      <span className="relative text-right text-primary">{level.shares.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
      <span className="relative text-right text-secondary">{level.total.toLocaleString(undefined, { maximumFractionDigits: 0 })}</span>
    </li>
  );
}
