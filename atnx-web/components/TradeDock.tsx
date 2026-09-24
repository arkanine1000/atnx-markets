"use client";

import { useEffect, useState, type ReactNode } from "react";

// The market page's order ticket on phones, the way Polymarket does it:
// Long and Short anchored to the bottom of the screen where the tab bar
// would be, and the ticket itself (amount, leverage, submit) in a sheet
// that slides up when one of them is tapped. The page behind stays
// scrollable: chart, pulse and activity are all still there, only the
// ticket waits behind the buttons. Desktop keeps the ticket in its
// column; this renders nothing there.

export type Side = "long" | "short";

export function TradeDock({
  renderTicket,
}: {
  // The ticket for the side that was tapped; a fresh one each time so it
  // opens on that side.
  renderTicket: (side: Side) => ReactNode;
}) {
  const [side, setSide] = useState<Side | null>(null);

  useEffect(() => {
    if (!side) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") setSide(null);
    }
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prev;
      window.removeEventListener("keydown", onKey);
    };
  }, [side]);

  return (
    <div className="lg:hidden" data-no-swipe>
      {side && (
        <div
          className="fixed inset-0 z-50 flex items-end"
          style={{
            backgroundColor: "rgba(0,0,0,0.6)",
            backdropFilter: "blur(4px)",
          }}
          onClick={() => setSide(null)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={side === "long" ? "Open a long" : "Open a short"}
            onClick={(e) => e.stopPropagation()}
            className="w-full max-h-[88svh] overflow-y-auto rounded-t-2xl bg-surface border-t border-surface shadow-2xl animate-slide-up pb-[env(safe-area-inset-bottom)]"
          >
            <div className="relative flex items-center justify-center pt-2.5 pb-1">
              <span
                aria-hidden="true"
                className="h-1 w-10 rounded-full bg-elevated"
              />
              <button
                type="button"
                onClick={() => setSide(null)}
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

      <div className="fixed inset-x-0 bottom-0 z-40 nav-blur border-t border-surface pb-[env(safe-area-inset-bottom)]">
        <div className="h-16 px-4 flex items-center gap-3 max-w-6xl mx-auto">
          <button
            type="button"
            onClick={() => setSide("long")}
            className="btn-cyan flex-1 h-11 rounded-xl font-bold text-sm cursor-pointer inline-flex items-center justify-center gap-1.5"
          >
            <span aria-hidden="true">{"↗"}</span> Long
          </button>
          <button
            type="button"
            onClick={() => setSide("short")}
            className="btn-magenta flex-1 h-11 rounded-xl font-bold text-sm cursor-pointer inline-flex items-center justify-center gap-1.5"
          >
            <span aria-hidden="true">{"↘"}</span> Short
          </button>
        </div>
      </div>
    </div>
  );
}
