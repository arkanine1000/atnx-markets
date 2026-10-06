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

// Where the round stands for the card. `left` is the time to the close
// (live) or to the opening (waiting); null until the clock has hydrated.
type Phase =
  | { kind: "live"; left: number | null }
  | { kind: "closing" }
  | { kind: "settling" }
  | { kind: "waiting"; left: number | null }
  | { kind: "opening" };

function roundPhase(info: RoundBadgeInfo, now: number | null): Phase | null {
  switch (info.state) {
    case "presale": {
      if (now === null) return { kind: "waiting", left: null };
      const opens = Date.parse(info.opensAt);
      return now < opens ? { kind: "waiting", left: opens - now } : { kind: "opening" };
    }
    case "opening":
      return { kind: "opening" };
    case "settling":
      return { kind: "settling" };
    case "live": {
      const close = info.closeAt ? Date.parse(info.closeAt) : null;
      const tradeUntil = info.tradeUntil ? Date.parse(info.tradeUntil) : null;
      if (now === null || close === null) return { kind: "live", left: null };
      if (now >= close) return { kind: "settling" };
      if (tradeUntil !== null && now >= tradeUntil) return { kind: "closing" };
      return { kind: "live", left: close - now };
    }
    default:
      return null;
  }
}

// The hover text: the round number and, once set, the target the cards
// no longer print.
function roundTitle(info: RoundBadgeInfo, vi: number): string {
  if (info.state === "presale") return `Round ${info.idx} is taking commits`;
  if (info.target === null) return `Round ${info.idx}`;
  return `Round ${info.idx}: UP wins if the index ends at or above ${Math.round(info.target)}. VI now ${Math.round(vi)}.`;
}

const CYAN = "text-atnx-cyan light:text-atnx-cyan-light";
const MAGENTA = "text-atnx-magenta light:text-atnx-magenta-light";

// The status pill: "LIVE · 3h 55m" in cyan while a round runs, "LIVE ·
// closing" in the averaging window, "SETTLING", "OPENS IN 42m" and
// "OPENING" in grey. `overlay` sits on the tile's image beside the rank
// chip and matches it (always on a dark ground, so no light-theme
// colours); `inline` is the list row's, on the card surface.
export function RoundPill({
  info,
  vi,
  variant = "overlay",
  className = "",
}: {
  info: RoundBadgeInfo;
  vi: number;
  variant?: "overlay" | "inline";
  className?: string;
}) {
  const now = useNow();
  const phase = roundPhase(info, now);
  if (!phase) return null;

  const text =
    phase.kind === "live"
      ? phase.left === null ? "LIVE" : `LIVE · ${fmtLeft(phase.left)}`
      : phase.kind === "closing"
        ? "LIVE · closing"
        : phase.kind === "settling"
          ? "SETTLING"
          : phase.kind === "waiting"
            ? phase.left === null ? "OPENS SOON" : `OPENS IN ${fmtLeft(phase.left)}`
            : "OPENING";
  const live = phase.kind === "live" || phase.kind === "closing";
  const shape =
    variant === "overlay"
      ? `h-6 text-[11px] bg-black/60 backdrop-blur ${live ? "text-atnx-cyan" : "text-white/70"}`
      : `h-5 text-[10px] border border-surface bg-elevated ${live ? CYAN : "text-secondary"}`;

  return (
    <span
      className={`px-1.5 inline-flex items-center rounded-md font-bold font-mono tabular-nums whitespace-nowrap ${shape} ${className}`}
      title={roundTitle(info, vi)}
    >
      {text}
    </span>
  );
}

// The line under the market name: which side would win if the round
// closed now (the index at or above the target is UP), "Closing now" in
// the averaging window, "Settling", or "Starts in 42m" for a round
// waiting to open. The card sets the size to match its category label.
export function RoundVerdict({
  info,
  vi,
  className = "",
}: {
  info: RoundBadgeInfo;
  vi: number;
  className?: string;
}) {
  const now = useNow();
  const phase = roundPhase(info, now);
  if (!phase) return null;

  let tone = "text-secondary";
  let body: React.ReactNode;
  if (phase.kind === "live") {
    if (info.target === null) {
      body = "Round live";
    } else {
      const up = vi >= info.target;
      tone = up ? CYAN : MAGENTA;
      body = (
        <>
          <span className="font-bold">{up ? "UP" : "DOWN"}</span> is winning
        </>
      );
    }
  } else if (phase.kind === "closing") {
    body = "Closing now";
  } else if (phase.kind === "settling") {
    body = "Settling";
  } else if (phase.kind === "waiting") {
    body = phase.left === null ? "Starts soon" : `Starts in ${fmtLeft(phase.left)}`;
  } else {
    body = "Starting";
  }

  return (
    <div className={`truncate tabular-nums ${tone} ${className}`} title={roundTitle(info, vi)}>
      {body}
    </div>
  );
}
