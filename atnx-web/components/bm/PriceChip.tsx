"use client";

import { fmtCents } from "./format";
import { BoundsRail } from "./BoundsRail";
import { liveRow, useBmChain, useOnchainMarket } from "./useBounded";
import type { BmMarketRow } from "@/lib/supabase/database-bm";

// "UP 52¢ · DOWN 48¢ · bounds 20–500" for the market page header.
export function PriceChip({ bounded, vi }: { bounded: BmMarketRow[]; vi: number }) {
  const { chain } = useBmChain();
  const row = liveRow(bounded, chain.key);
  const oc = useOnchainMarket(chain, row);
  if (!row) return null;
  return (
    <div className="mt-2 max-w-sm">
      <div className="flex items-center gap-3 text-[11px] font-mono tabular-nums mb-1">
        {oc.priceUp !== null ? (
          <>
            <span className="text-atnx-cyan">UP {fmtCents(oc.priceUp)}</span>
            <span className="text-atnx-magenta">DOWN {fmtCents(1 - oc.priceUp)}</span>
          </>
        ) : (
          <span className="text-tertiary">{row.state === "pending" ? "opening on chain…" : "…"}</span>
        )}
      </div>
      <BoundsRail lower={row.lower_bound} upper={row.upper_bound} vi={vi} />
    </div>
  );
}
