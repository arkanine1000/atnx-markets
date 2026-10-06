"use client";

import { mprUp } from "@/lib/bm/dpm";
import type { BmRoundRow, BmSeriesRow } from "@/lib/supabase/database-bm";
import { fmtLeft, liveRoundRow, presaleRoundRow, useNow, useRoundState } from "./useRounds";

// "Round 12 · UP 61% · target 143 · 3h 12m" for the market page header,
// in place of the bounded market's PriceChip. The chance of UP comes from
// the chain (shared with the ticket's query); the rest from the registry
// until the chain read lands.
export function RoundChip({ series, rounds, vi }: { series: BmSeriesRow; rounds: BmRoundRow[]; vi: number }) {
  const now = useNow();
  const { data } = useRoundState(series, rounds);
  const liveRow = liveRoundRow(rounds);
  const presaleRow = presaleRoundRow(rounds);
  const live = data?.live?.account ?? null;

  if (live || liveRow) {
    const idx = live?.index ?? liveRow!.idx;
    const target = live ? Number(live.targetE2) / 100 : liveRow!.target_vi;
    const closeAt = live ? live.closeAt * 1000 : liveRow!.close_at ? new Date(liveRow!.close_at).getTime() : null;
    const pUp = live ? mprUp(live) : null;
    const above = target !== null && vi >= target;
    return (
      <div className="mt-2 flex items-center gap-x-2 gap-y-1 flex-wrap text-[11px] tabular-nums">
        <span className="text-secondary">Round {idx}</span>
        {pUp !== null && (
          <>
            <span className="text-tertiary">·</span>
            <span className="text-atnx-cyan light:text-atnx-cyan-light">UP {Math.round(pUp * 100)}%</span>
          </>
        )}
        {target !== null && (
          <>
            <span className="text-tertiary">·</span>
            <span className={above ? "text-atnx-cyan light:text-atnx-cyan-light" : "text-atnx-magenta light:text-atnx-magenta-light"} title={`VI now ${Math.round(vi)}`}>
              target {Math.round(target)}
            </span>
          </>
        )}
        {closeAt !== null && now !== null && (
          <>
            <span className="text-tertiary">·</span>
            <span className="text-tertiary">{now < closeAt ? fmtLeft(closeAt - now) : "settling"}</span>
          </>
        )}
      </div>
    );
  }

  if (presaleRow) {
    const opens = new Date(presaleRow.opens_at).getTime();
    return (
      <div className="mt-2 flex items-center gap-2 text-[11px] tabular-nums">
        <span className="text-secondary">Round {presaleRow.idx}</span>
        <span className="text-tertiary">·</span>
        <span className="text-tertiary">{now !== null ? (now < opens ? `opens in ${fmtLeft(opens - now)}` : "opening") : "opens soon"}</span>
      </div>
    );
  }
  return null;
}
