"use client";

import type { BmRoundState } from "@/lib/supabase/database-bm";
import { fmtLeft, useNow } from "./time";

// What a listing tile needs to know about a market's current round, from
// the registry only (no chain reads in lists). Built on the server from
// listLiveRounds() in app/app/page.tsx.
export interface RoundBadgeInfo {
  idx: number;
  state: BmRoundState;
  target: number | null;
  closeAt: string | null;
  tradeUntil: string | null;
  opensAt: string;
  fast: boolean;
}

// "R12 · 3h left · target 143": cyan while the index is at or above the
// target (UP would win if the round closed now), magenta below.
export function RoundBadge({ info, vi, compact = false, className = "" }: { info: RoundBadgeInfo; vi: number; compact?: boolean; className?: string }) {
  const now = useNow();
  // One step up from BoundsRail's mono sizes: the body face runs smaller
  // than Martian Mono at the same pixel size; the leading keeps the row
  // the rail's height.
  const size = compact ? "text-[10px] leading-[1.35]" : "text-[11px] leading-[1.35]";

  if (info.state === "presale") {
    const opens = new Date(info.opensAt).getTime();
    return (
      <div className={`flex items-center gap-1.5 ${size} tabular-nums text-secondary ${className}`} title={`Round ${info.idx} is taking commits`}>
        <span className="font-bold">R{info.idx}</span>
        <span className="text-tertiary">·</span>
        <span>presale{now !== null && now < opens ? ` · opens ${fmtLeft(opens - now)}` : ""}</span>
      </div>
    );
  }

  const target = info.target;
  const above = target !== null && vi >= target;
  const tone = target === null ? "text-secondary" : above ? "text-atnx-cyan light:text-atnx-cyan-light" : "text-atnx-magenta light:text-atnx-magenta-light";
  const close = info.closeAt ? new Date(info.closeAt).getTime() : null;
  const tradeUntil = info.tradeUntil ? new Date(info.tradeUntil).getTime() : null;
  const when =
    now === null || close === null
      ? null
      : now >= close || info.state === "settling"
        ? "settling"
        : tradeUntil !== null && now >= tradeUntil
          ? "averaging"
          : `${fmtLeft(close - now)} left`;

  return (
    <div
      className={`flex items-center gap-1.5 ${size} tabular-nums ${tone} ${className}`}
      title={target !== null ? `Round ${info.idx}: UP wins if the index ends at or above ${Math.round(target)}. VI now ${Math.round(vi)}.` : `Round ${info.idx}`}
    >
      <span className="font-bold">R{info.idx}</span>
      {when && (
        <>
          <span className="opacity-60">·</span>
          <span>{when}</span>
        </>
      )}
      {target !== null && (
        <>
          <span className="opacity-60">·</span>
          <span>target {Math.round(target)}</span>
        </>
      )}
    </div>
  );
}
