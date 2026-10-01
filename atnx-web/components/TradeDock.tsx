"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

// The market page's order ticket on phones, the way Polymarket does it:
// UP and DOWN anchored just above the tab bar (Markets, +, Portfolio
// stay where a thumb expects them), and the ticket itself (amount,
// quote, submit) in a sheet that slides up from the bottom edge when
// one of them is tapped. The page behind stays scrollable: chart, pulse
// and activity are all there, only the ticket waits behind the buttons.
// Desktop keeps the ticket in its column; this renders nothing there.

// How long the closing animation runs before the sheet unmounts.
const CLOSE_MS = 200;

export type Side = "up" | "down";

export function TradeDock({
  renderTicket,
}: {
  // The ticket for the side that was tapped; a fresh one each time so it
  // opens on that side.
  renderTicket: (side: Side) => ReactNode;
}) {
  const [side, setSide] = useState<Side | null>(null);
  const [closing, setClosing] = useState(false);
  const closeTimer = useRef<number | null>(null);

  // The sheet plays its way out, then unmounts.
  const close = () => {
    if (!side || closing) return;
    setClosing(true);
    closeTimer.current = window.setTimeout(() => {
      setSide(null);
      setClosing(false);
      closeTimer.current = null;
    }, CLOSE_MS);
  };
  const open = (next: Side) => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
      closeTimer.current = null;
    }
    setClosing(false);
    setSide(next);
  };

  useEffect(
    () => () => {
      if (closeTimer.current) window.clearTimeout(closeTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!side) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") close();
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
    // close reads the latest state through its closure each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [side]);

  return (
    <div className="lg:hidden" data-no-swipe>
      {side && (
        <div
          className={`fixed inset-0 z-50 flex items-end ${closing ? "animate-fade-out" : "animate-fade-in"}`}
          style={{
            backgroundColor: "rgba(0,0,0,0.6)",
            backdropFilter: "blur(4px)",
          }}
          onClick={close}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={side === "up" ? "Buy UP" : "Buy DOWN"}
            onClick={(e) => e.stopPropagation()}
            className={`w-full max-h-[88svh] overflow-y-auto rounded-t-2xl bg-surface border-t border-surface shadow-2xl pb-[env(safe-area-inset-bottom)] ${
              closing ? "animate-sheet-down" : "animate-sheet-up"
            }`}
          >
            <div className="relative flex items-center justify-center pt-2.5 pb-1">
              <span
                aria-hidden="true"
                className="h-1 w-10 rounded-full bg-elevated"
              />
              <button
                type="button"
                onClick={close}
                aria-label="Close"
                className="absolute right-3 top-1.5 h-8 w-8 rounded-full inline-flex items-center justify-center text-secondary hover:text-primary hover:bg-elevated cursor-pointer transition-colors"
              >
                {"✕"}
              </button>
            </div>
            <div className="px-3 pb-3">{renderTicket(side)}</div>
          </div>
        </div>
      )}

      {/* Above the phone tab bar (4rem plus the safe area); from sm up
          there is no bar, so it sits on the bottom edge itself. */}
      <div className="fixed inset-x-0 bottom-[calc(4rem+env(safe-area-inset-bottom))] sm:bottom-0 z-40 nav-blur border-t border-surface sm:pb-[env(safe-area-inset-bottom)]">
        <div className="h-14 px-4 flex items-center gap-3 max-w-6xl mx-auto">
          <button
            type="button"
            onClick={() => open("up")}
            className="btn-cyan flex-1 h-11 rounded-xl font-bold text-sm cursor-pointer inline-flex items-center justify-center gap-1.5"
          >
            <span aria-hidden="true">{"↗"}</span> UP
          </button>
          <button
            type="button"
            onClick={() => open("down")}
            className="btn-magenta flex-1 h-11 rounded-xl font-bold text-sm cursor-pointer inline-flex items-center justify-center gap-1.5"
          >
            <span aria-hidden="true">{"↘"}</span> DOWN
          </button>
        </div>
      </div>
    </div>
  );
}
