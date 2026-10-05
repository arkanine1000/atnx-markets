"use client";

import { useSyncExternalStore } from "react";

// Clock and duration text for the rounds UI. Kept apart from useRounds.ts
// so the listing badges do not pull the Solana program code into the
// markets page.

// One shared clock for every countdown on the page, ticking each second
// while anything is subscribed. The server snapshot is null so a
// countdown renders nothing on the server and fills in after hydration.
let nowMs = 0;
let timer: ReturnType<typeof setInterval> | null = null;
const listeners = new Set<() => void>();

function subscribeNow(cb: () => void) {
  listeners.add(cb);
  if (!timer) {
    nowMs = Date.now();
    timer = setInterval(() => {
      nowMs = Date.now();
      for (const l of listeners) l();
    }, 1_000);
  }
  return () => {
    listeners.delete(cb);
    if (listeners.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

function nowSnapshot(): number {
  if (!nowMs) nowMs = Date.now();
  return nowMs;
}

export function useNow(): number | null {
  return useSyncExternalStore(subscribeNow, nowSnapshot, () => null);
}

// "3h 12m", "12m", "45s".
export function fmtLeft(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const d = Math.floor(s / 86_400);
  const h = Math.floor((s % 86_400) / 3_600);
  const m = Math.floor((s % 3_600) / 60);
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${s}s`;
}

// "24 hours", "1 hour", "30 minutes".
export function fmtSpan(secs: number): string {
  if (secs >= 3_600 && secs % 3_600 === 0) {
    const h = secs / 3_600;
    return `${h} ${h === 1 ? "hour" : "hours"}`;
  }
  if (secs >= 60) {
    const m = Math.round(secs / 60);
    return `${m} ${m === 1 ? "minute" : "minutes"}`;
  }
  return `${secs} seconds`;
}

