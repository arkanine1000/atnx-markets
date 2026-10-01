"use client";

import { fmtCents } from "./format";
import { liveRow, useBmChain, useOnchainMarket } from "./useBounded";
import type { BmMarketRow } from "@/lib/supabase/database-bm";

// "UP 52¢ · DOWN 48¢ · bounds 20–500" for the market page header.
export function PriceChip({ bounded }: { bounded: BmMarketRow[] }) {
  const { chain } = useBmChain();
  const row = liveRow(bounded, chain.key);
  const oc = useOnchainMarket(chain, row);
  if (!row) return null;
  return (
    <span className="inline-flex items-center gap-2 text-[11px] font-mono tabular-nums">
      {oc.priceUp !== null ? (
        <>
          <span className="text-atnx-cyan">UP {fmtCents(oc.priceUp)}</span>
          <span className="text-atnx-magenta">DOWN {fmtCents(1 - oc.priceUp)}</span>
        </>
      ) : (
        <span className="text-tertiary">{row.state === "pending" ? "opening…" : "…"}</span>
      )}
      <span className="text-tertiary">
        bounds {row.lower_bound}–{row.upper_bound}
      </span>
    </span>
  );
}
